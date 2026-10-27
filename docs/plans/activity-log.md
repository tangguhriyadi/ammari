# Log Aktivitas (`/activity-log`): read-only audit log viewer

Status: **built 2026-10-27.** No migration. No owner decision was needed.

Goal: a super_admin can answer "who changed what, when" from the admin, on a phone, without SQL.

---

## 1. Findings

**Schema** (`packages/db/src/schema/rbac.ts`, unchanged since 0001):

```
audit_log
  id                   uuid PK default gen_random_uuid()
  actor_staff_user_id  uuid NULL  -> staff_users(id) ON DELETE RESTRICT  (NULL = system or buyer)
  action               text NOT NULL   (no CHECK on purpose: open-ended, see SPEC §9)
  entity_type          text NOT NULL
  entity_id            text NOT NULL   (uuid as text, except product_type = code, product_variant
                                        activate/deactivate = sku, sales_goal = "1",
                                        production_batch_accessory_override = "<batchId>:<accessoryId>")
  before, after        jsonb NULL
  created_at           timestamptz NOT NULL default now()
indexes: (entity_type, entity_id), (actor_staff_user_id), (created_at)
```

**Writers.** Two helpers, one direct insert: `writeAuditLog` in `@ammari/commerce/db` (admin and
commerce), `apps/web/src/lib/db.ts` (`actor` always NULL), and the order login link plugin in
`packages/auth`. ~100 call sites, 34 entity types.

**Action keys are generic** (`create`, `update`, `void`, `reverse`...): an action only means
something paired with its `entity_type`. So the label catalog is keyed by `(entity_type, action)`,
not by action. Only staff and roles use namespaced constants (`STAFF_AUDIT_ACTIONS`,
`ROLE_AUDIT_ACTIONS`). Dynamic values found: ternaries (`activate`/`deactivate`, `print`/`reprint`,
`create`/`update`) and the shipment tracking `options.action` (`book_shipment`, `refresh_shipment`,
`track_shipment_poll`, `track_shipment_webhook`). Full list: `apps/admin/src/lib/activity-log/catalog.ts`;
the test `catalog.test.ts` scans every non-test source file in `apps/*/src` and `packages/*/src`
and fails on any write whose pair has no label or whose action cannot be resolved statically.

**Non-staff actors.** `actor_staff_user_id IS NULL` is either the buyer (web checkout, card
claim, saved address delete, order login link) or the system (tracking poll/webhook, booking
failure, stale tracking flags, imports never: imports have a staff actor). The catalog marks the
buyer entries; everything else with NULL shows "Sistem".

**Secrets.** Verified: the raw claim token is never stored. `thank_you_card` rows carry the card
row, which includes `tokenHash` (a hash, per CLAUDE.md). OTP codes, passwords and session tokens
never reach `audit_log`. The viewer still redacts, recursively, any key matching
`token|secret|password|passwd|otp|hash|api_key|apikey|credential|signature|private_key|cookie`
before anything leaves the server (defence in depth; covers future writers).

**Volume.** Local dev: 101 rows over 3 weeks, 200 kB. Prod is not reachable from here (no server
access in this task); the main drivers are orders (create/import, status transitions, shipment
tracking changes) and card prints, so even a busy month is in the low thousands of rows/day.

**Indexes: none added.** Benchmarked on a throwaway `ammari_scratch` database (dropped after)
with 1,000,000 synthetic rows over 365 days (well beyond 10x), skewed actors (one staffer at 0.4%)
and a rare entity type (0.2%):

| Query | Plan | Time |
|---|---|---|
| default 7 days, count + page 1 | `created_at` index | 14 ms / <1 ms |
| rare staffer, 365 days, count + page 11 | actor index / `created_at` backward | 13 ms / 60 ms |
| rare area, 365 days, count + page 1 | `(entity_type, entity_id)` bitmap | 4 ms / 11 ms |
| area as `(entity_type, action)` pairs + offset 100 | entity bitmap | 3.5 ms |
| entity search (order number), 365 days, count + page | resolve ids (27 ms) then entity bitmap | 5 ms / 3.5 ms |

Entity search was first written as `entity_id IN (subquery)` per entity type. The database review
flagged that a hashed SubPlan cannot drive an index scan, and a second benchmark (1M rows, 100k
orders) confirmed it: 78 ms count / 368 ms page, filtering every row in the range. It now runs in
two steps (`resolveSearchTargets`): one capped `UNION ALL` (500 entities) turns the term into
`(entity_type, id)` pairs, then audit_log is filtered on literal id lists. A broader term shows a
"be more specific" note instead of an unbounded query.

The worst case is 60 ms, so a migration is not justified. If prod ever reaches several million
rows, `(actor_staff_user_id, created_at)` is the first index to add (additive, backward-compatible).

**Append-only: not protected today.** The app role owns the table (INSERT/UPDATE/DELETE/TRUNCATE
granted), no trigger. No application code updates or deletes `audit_log` (verified by grep). This
feature adds no edit/delete UI. **Follow-up** (needs an owner decision, not part of this feature):
migration with a `BEFORE UPDATE OR DELETE ... FOR EACH ROW` trigger that raises. Row triggers do not
fire on `TRUNCATE`, so the e2e/test resets keep working. Open question for that follow-up: any
future PDP "delete my data" request would need a documented bypass. A trigger does not stop the
table owner (the app role today) from `ALTER TABLE ... DISABLE TRIGGER`; real protection is a
separate app role without UPDATE/DELETE/TRUNCATE on `audit_log`. The trigger is INSERT-safe, so it
keeps `writeAuditLog` rollback-compatible.

---

## 2. Access

`audit_log.view` only (today: super_admin; `SUPER_ADMIN_ONLY_PERMISSION_KEYS` keeps the role
editor from granting it). `requirePermission("audit_log.view")` on the list page, the detail page,
and the CSV route handler (401/403 in the handler itself). Nav already filters on it.

## 3. UI (Indonesian, phone first, no em dash)

- **List** `/activity-log`: newest first, Jakarta time, actor (staff name + email, or Sistem /
  Pembeli), action label, area, entity label linked to its admin page when one exists (falls back to
  a name/number found in the payload, then to a short id). `CardList` on phones,
  `TableContainer` on tablet/desktop. Each entry links to its detail.
- **Filters** (GET form, all in the URL, combinable): `from`/`to` (default last 7 Jakarta days),
  `actor` (staff id, or `system` = no staff actor), `area`, `q` (entity search: exact id, order
  number / marketplace order number, product name/code, SKU, supplier, BYR-, PO, receipt and batch
  numbers, staff name/email, role, fabric, accessory, size chart, info page, import file, customer
  name/email). Pagination via the shared `Pagination`.
- **Areas**: Pesanan, Pengiriman, Pembayaran, Produk & Diskon, Stok, Produksi & Pembelian,
  Staf & Peran, Impor, Konten, Pengaturan, Kartu & Pembeli, Lainnya (unknown pairs).
- **Detail** `/activity-log/[id]`: header facts, then a field-by-field diff (changed fields first,
  unchanged ones collapsed), Indonesian labels for known fields, raw key otherwise, nested objects
  flattened one level, arrays/deeper values as collapsible JSON (`<details>`). Redacted values show
  "(disembunyikan)".
- **CSV** `/activity-log/export`: same filters, summary columns only (no payloads), capped at 5,000
  rows, writes its own audit row (`audit_log` / `export`) with the filters and row count.

## 4. Files

- `apps/admin/src/lib/activity-log/catalog.ts`: entity types, action labels, areas, buyer actors.
- `.../fields.ts`, `.../diff.ts`: field labels, value formatting, redaction, diff rows.
- `.../filters.ts`: URL parsing/serialising (pure).
- `.../queries.ts`: list, count, detail, entity resolution, actor options, export (server-only).
- `apps/admin/src/app/(shell)/activity-log/{page.tsx,[id]/page.tsx,export/route.ts,_components/*}`.

## 5. Tests

Unit: catalog scan (every write in the codebase has a label), labels/areas, unknown keys, redaction,
diff rendering, filter parsing; DB: each filter and their combination, entity resolution; route:
401/403, CSV, cap, self-audit. E2E `activity-log.spec.ts`: super_admin sees, filters, opens a detail
(redacted token hash), owner gets 403 on page and export, at 390px and 1280px.

Not searchable by name (only by exact id): `defect_movement`, `storefront_homepage_section`,
`store_settings`, `sales_goal`, `audit_log`. The list and CSV never load payloads: a fallback
label is computed in SQL from a few name/number keys (never `code`, `key` or `email`).
