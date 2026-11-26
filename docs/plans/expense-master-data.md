# Expense categories and cost items as master data ("Kategori Biaya")

Status: **implemented (sessions S1 to S6).** Owner request 2026-11-26: manage the categories and
cost items of "Iklan & Biaya" → "Catat biaya" from Data Master, so that recording an expense means
picking a category and then an item from that category's list. §1 and §2 describe the state
*before* this work; §3 is the design as built, with the S6 notes in §3.12.

Revision 2 (2026-11-26): owner answered D1–D6 (§5) and added scope: split "Iklan & Biaya" into
two menus, **Iklan** and **Biaya** (§3.8), a read-only **Pengeluaran produksi** tab fed by
supplier payments (§3.9), a monthly **cash-out summary** (§3.10), and accounting guards so that
purchase and production payments never reach Laba bersih, ROAS or the P&L (§3.11).

Open decisions are marked **(D#)** in §5. Each has a recommendation.

---

## 1. How it works today

### 1.1 Categories are a fixed constant, enforced by CHECKs

- `packages/db/src/schema/constants.ts:418` `BUSINESS_EXPENSE_CATEGORIES`: ten fixed codes,
  `ads_meta, ads_tiktok, ads_shopee, endorsement, material_shipping, packaging, salary, rent,
  utilities, other`. The comment says "A FIXED set (owner answer Q1) … Adding one is a CHECK
  widen in a migration."
- Derived constants carry the business logic:
  - `AD_EXPENSE_CATEGORIES` (`ads_meta/ads_tiktok/ads_shopee`): what ROAS divides by.
  - `MARKETING_EXPENSE_CATEGORIES` (ads plus `endorsement`): may name a sales channel.
  - `FIXED_EXPENSE_CHANNELS` (`ads_shopee → shopee`, `ads_tiktok → tiktok`).
- Indonesian labels, the two picker groups ("Iklan" / "Operasional"), field hints and the
  monthly-bill options live in `apps/admin/src/lib/expenses/labels.ts`.

### 1.2 There is no "cost item" yet

`business_expenses` (`packages/db/src/schema/expenses.ts`, migration 0042) has `category text`,
`amount`, `method`, `channel_id`, `campaign` (marketing only, max 120), `note` (max 500,
**required for `other`**) and a required proof. The only free-text descriptors today are
`campaign` and `note`. Nothing like "Biteship Grow" or "VPS" can be picked. It goes in the note,
or the category is "Lainnya".

The never-used `expenses` table from migration 0000 (`EXPENSE_CATEGORIES`) is unrelated and out of
scope.

### 1.3 DB constraints that hard-code the category list

| Constraint | What it pins |
|---|---|
| `business_expenses_category_check` | `category IN (<10 codes>)` |
| `business_expenses_channel_check` | `CASE` on category: Shopee/TikTok ads fixed channel, other marketing optional, every other category `channel_id IS NULL` |
| `business_expenses_other_note_check` | `category <> 'other' OR note IS NOT NULL` |
| `sales_goal_monthly_bill_categories_allowed_check` | `monthly_bill_categories ⊆ <10 codes>` |
| index `business_expenses_category_expense_date_idx` | used by the monthly-bill reminder |

`business_expenses` is append-only. The `prevent_voidable_record_mutation` trigger (0038) compares
`to_jsonb(NEW)` with `to_jsonb(OLD)` minus the void columns, so adding a nullable column is safe,
but **existing rows can never be backfilled** without that trigger refusing.

### 1.4 Where categories drive logic

| Area | File | Depends on |
|---|---|---|
| Channel rule (form and server) | `lib/expenses/figures.ts` `expenseChannelRule/expenseChannelError` | `FIXED_EXPENSE_CHANNELS`, `MARKETING_EXPENSE_CATEGORIES` |
| ROAS, biaya iklan per channel, Endorse line | `figures.ts` `summarizeMarketing` → `summary.ts` `buildRoasRows` | `AD_EXPENSE_CATEGORIES`, literal `"endorsement"` |
| Titik impas ROAS | `figures.ts` `breakEvenRoas` | margin only, **not** categories. Only the ROAS it is compared with uses ad spend |
| Laba bersih / Ringkasan "Biaya operasional & iklan" | `summary.ts` `getExpenseBreakdown` (grouped by category, sorted by `BUSINESS_EXPENSE_CATEGORIES.indexOf`), `getExpenseTotal` (Overview tile) | order constant; the total is category-agnostic |
| Monthly PDF/XLSX report | `report-content.ts` (P&L detail lines per category), `report-xlsx.ts` (row label) | `EXPENSE_CATEGORY_LABELS` |
| List, filters, group tabs | `records.ts` `listBusinessExpenses`, `search-params.ts`, `page.tsx`, `expense-list.tsx` | `EXPENSE_CATEGORY_GROUPS`, `BUSINESS_EXPENSE_CATEGORIES` |
| Record form | `record-expense-button.tsx`, `actions.ts` (`z.enum(BUSINESS_EXPENSE_CATEGORIES)`), `records.ts` `normalizeExpenseInput` | all of the above, plus the `other` note rule |
| Monthly bill reminder (Gaji/Sewa/Utilitas) | `lib/settings/monthly-bills.ts`, `settings/_components/monthly-bills-form.tsx`, `summary.ts` `getMonthlyBillsStatus`, `overview-needs-action.tsx` (the "Operasional" tab link) | `MONTHLY_BILL_CATEGORY_OPTIONS = salary, rent, utilities`; `sales_goal.monthly_bill_categories` |
| Audit log | `activity-log/catalog.ts` `business_expense` (record/void), `expense_report` (download); `fields.ts` `category: "Kategori"` | raw code shown as the value |
| Permissions | `ads_expenses.manage` **and** `finance.view_profit` on every page/action (`actions.ts` `EXPENSE_KEYS`, `page.tsx`) | role `finance` and owner/super_admin hold it |

**Which codes the logic truly depends on:** `ads_meta`, `ads_tiktok`, `ads_shopee` (ROAS, fixed
channels), `endorsement` (marketing line, outside ROAS) and `other` (note required). `salary`,
`rent` and `utilities` are only the default monthly-bill options, and `material_shipping` only has
a hint. None of those three is logic.

### 1.5 Production cash today (input for §3.9)

- `supplier_payments` (`packages/db/src/schema/supplier-payments.ts`, 0038) is append-only like
  `business_expenses`. Each row pays exactly one target: a **purchase** (`purchase_id`, always with
  a supplier) or a **posted production batch** (`production_batch_id`, one payee per payment:
  `supplier_id` or NULL for unattributed lines). It has `paid_at` (date), `amount`, `method`
  (cash/transfer), `payment_no`, and a void triple.
- Purchases contain only `fabric`/`accessory` lines (`PURCHASE_ITEM_TYPES`). A batch's payable
  is its posted **service** lines only (`production_batch_costs`, `lib/supplier-payments/batch-payments.ts`),
  each with `component_name` (snapshot, e.g. "Ongkos jahit") and a payee. A payment is per
  **batch + payee**, not per cost line. One payee can cover several components.
- Document numbers: `purchases.purchase_no` (PO-YYYYMM-NNN), `production_batches.batch_no`.
  Detail pages: `/purchases/[id]` (`inventory.view`) and `/production/[id]`
  (`production.manage`). The Keuangan role has `inventory.view` but **not** `production.manage`.
- **Today these payments touch no expense figure.** `lib/expenses/*` reads `supplier_payments`
  only for the duplicate-proof check (`records.ts:165`). Purchase and production cost reaches the
  P&L only as HPP of sold orders. The new tab must keep it that way.

### 1.6 The current "Iklan & Biaya" screen

`/ads-expenses` (one page, `requireAllPermissions(["ads_expenses.manage", "finance.view_profit"])`):

- Tab "Pengeluaran": every expense, with group tabs Semua/Iklan/Operasional and filters `month`,
  `from/to`, `group`, `category`, `voided`, `q`, `page`.
- Tab "Ringkasan" (`?tab=ringkasan&period=…`): P&L down to Laba bersih, Biaya pemasaran, ROAS per
  channel and Titik impas, and "Unduh laporan bulanan" → `/ads-expenses/report?format=pdf|xlsx&…`.

Inbound links: nav, `/iklan-biaya` (308 in `next.config.ts`), the Overview Laba bersih tile
(`expenseSummaryHref`), the monthly-bill reminder (`expenseListHref`), and activity-log entries
(`/ads-expenses?q=BYA-…`, `activity-log/queries.ts:483`).

## 2. Existing data

- **Local DB: not read.** Docker was not running (`Cannot connect to the Docker daemon`), and I
  did not start it. To check, run `docker compose up -d db` and then
  `select category, count(*), count(campaign), count(note) from business_expenses group by 1;`
  plus `select monthly_bill_categories from sales_goal;`.
- `packages/db/src/seed.ts` inserts **no** business expenses. Only the e2e setup does
  (`apps/admin/e2e/global-setup.ts:876`, plus `E2E_MONTHLY_BILL_CATEGORIES`). Any local rows were
  entered by hand.
- Whatever exists can only use the ten codes above (CHECK), and **no item data exists anywhere**.
  The mapping is therefore 1:1 by code, and there are no items to migrate.

---

## 3. Design

### 3.1 New tables (migration 0048)

```
expense_categories
  code              text PRIMARY KEY      -- CHECK ^[a-z][a-z0-9_]{0,39}$ and <> 'biaya_produksi' (§3.11); immutable (trigger)
  name              citext NOT NULL UNIQUE -- "Iklan Meta", "Langganan"; CHECK btrim <> '' , <= 60
  kind              text NOT NULL         -- 'ad' | 'endorsement' | 'operating'; immutable once set
  fixed_channel_id  text NULL REFERENCES channels(id)  -- only shopee/tiktok system ads
  is_system         boolean NOT NULL DEFAULT false
  is_active         boolean NOT NULL DEFAULT true
  sort_order        integer NOT NULL DEFAULT 0
  created_at / updated_at (set_updated_at trigger)
  CHECK (fixed_channel_id IS NULL OR kind = 'ad')
  CHECK (is_system OR fixed_channel_id IS NULL)    -- owners cannot invent fixed-channel rules
  CHECK (is_active OR NOT is_system)               -- system categories cannot be deactivated

expense_items
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid()
  category_code     text NOT NULL REFERENCES expense_categories(code) ON DELETE RESTRICT ON UPDATE RESTRICT
  name              citext NOT NULL       -- "Biteship Grow"; CHECK btrim <> '', <= 80
  note              text NULL             -- CHECK btrim <> '' , <= 200
  default_amount    bigint NULL           -- whole rupiah, CHECK > 0 (D4)
  is_active         boolean NOT NULL DEFAULT true
  sort_order        integer NOT NULL DEFAULT 0
  created_at / updated_at
  UNIQUE (category_code, name)
  UNIQUE (id, category_code)              -- target of the composite FK below
  index (category_code, is_active, sort_order)
```

**`kind` replaces the hard-coded lists.** It is the one switch the logic reads:

- `ad`: counted in biaya iklan / ROAS. The channel is fixed when `fixed_channel_id` is set,
  otherwise optional.
- `endorsement`: marketing, optional channel, own line, never in ROAS.
- `operating`: no channel, no campaign.

The "Iklan" / "Operasional" groups (tabs, picker optgroups) derive from it: `ad` and
`endorsement` → Iklan, `operating` → Operasional. A new category the owner adds with kind `ad`
(e.g. "Iklan Google") is therefore picked up by ROAS, the Iklan tab and the reports without a code
change. The form asks for the kind in plain words: "Jenis: Iklan / Endorse / Operasional".

`kind` is immutable (the trigger, together with `code`). Changing it would silently move
historical spend in or out of ROAS. If the owner gets it wrong, they deactivate the category and
create a new one. This is safe because nothing can be recorded against a category until it exists.

### 3.2 Seed rows (in the migration, `ON CONFLICT DO NOTHING`)

| code | name | kind | fixed channel | system | sort |
|---|---|---|---|---|---|
| ads_meta | Iklan Meta | ad | | ✓ | 10 |
| ads_tiktok | Iklan TikTok | ad | tiktok | ✓ | 20 |
| ads_shopee | Iklan Shopee | ad | shopee | ✓ | 30 |
| endorsement | Endorse/KOL | endorsement | | ✓ | 40 |
| material_shipping | Ongkir bahan | operating | | | 110 |
| packaging | Packaging | operating | | | 120 |
| salary | Gaji | operating | | | 130 |
| rent | Sewa | operating | | | 140 |
| utilities | Utilitas | operating | | | 150 |
| other | Lainnya | operating | | ✓ | 990 |

Names are today's `EXPENSE_CATEGORY_LABELS`, so nothing on screen changes on deploy. The codes
are today's values, so every existing `business_expenses.category` maps 1:1. These rows are
reference data the code matches by literal (`other`, the fixed channels), so they ship **in the
migration** (CLAUDE.md DB rule). `seed.ts` repeats them insert-only, because `e2e-db.ts`
truncates and re-seeds (same as `product_types`/`DRESS`).

System categories (`is_system`): they can be renamed and reordered, but they **cannot be
deactivated** (CHECK) and **cannot change code or kind** (trigger). The hint texts for
`material_shipping`/`endorsement`/`other` stay in code, keyed by code (a missing key shows no
hint).

**No items are seeded.** None exist, and the owner's examples (Langganan: Biteship Grow, Claude,
VPS) are owner data entered through the new page, not reference data (D2).

### 3.3 Changes to `business_expenses` (same migration, expand-only)

1. `ADD COLUMN item_id uuid NULL`, plus a composite FK `(item_id, category) → expense_items(id,
   category_code)` `ON DELETE RESTRICT ON UPDATE RESTRICT` (MATCH SIMPLE: a NULL item skips it).
   The DB then guarantees that an item belongs to the expense's category. Index on `item_id`.
   Existing rows stay `NULL`, and the append-only trigger is untouched (no backfill needed).
2. FK `category → expense_categories(code)` `ON DELETE RESTRICT ON UPDATE RESTRICT`. It validates
   immediately (tiny table, every row already uses a seeded code).
3. **Drop** `business_expenses_category_check`. The FK replaces it, and dropping relaxes, so it
   is backward-compatible.
4. **Replace** `business_expenses_channel_check` (its `ELSE channel_id IS NULL` would refuse a
   new `ad` category with a channel) with a `BEFORE INSERT` trigger
   `business_expense_channel_rule()`. The trigger looks up the category's `kind` and
   `fixed_channel_id`: fixed → `channel_id` must equal it; `ad`/`endorsement` → any or NULL;
   `operating` → NULL. Insert-only is enough, because rows never change except the void stamp.
   It is the same rule the old CHECK enforced for the ten seeded codes, so an old release inserts
   exactly as before.
5. Keep `business_expenses_other_note_check` (`other` is a stable system code).

`sales_goal.monthly_bill_categories`: **drop** `sales_goal_monthly_bill_categories_allowed_check`
(it pins the ten codes, and an array cannot carry an FK). The app validates against
`expense_categories` instead (D3).

Item name at record time: **not snapshotted.** The list and reports show the item's current name,
so a rename fixes a typo everywhere, and the audit log keeps the history. Deactivating an item
never touches past expenses.

### 3.4 Backward compatibility (prod/dev release before this one)

- An old release inserts with one of the ten codes and no `item_id`. The FK is satisfied
  (seeded, and system or still active), `item_id` is NULL, and the channel trigger gives the same
  verdict as the old CHECK. ✓
- An old release reads a row whose category was **created by the new release** (e.g.
  `langganan`). `EXPENSE_CATEGORY_LABELS[code]` is `undefined`, so the label renders empty and the
  summary sort puts it last. Amounts and totals stay correct. Accepted as a rollback-window
  cosmetic issue, documented here.
- An old release's `/settings` writes only salary/rent/utilities, which is still valid. ✓
- Contract step (a later release, optional): none required. The `BusinessExpenseCategory` union
  type and the constants are removed in code only.

### 3.5 App layer

**`lib/expense-categories/queries.ts`** (new; same shape as `lib/product-types/queries.ts`):

- Categories: `list` (with expense count and item count), `get`, `create` (code auto-generated
  from the name: `slugify(name)` to lowercase snake, suffixed `_2…` on conflict. The insert's
  unique-violation is mapped and retried; never check-then-insert), `update` (name, sort order),
  `setActive` (refused for `is_system` with a friendly error. The CHECK is the backstop).
- Items: `listByCategory`, `create`, `update` (name, note, default amount, sort order),
  `setActive`. Unique `(category_code, name)` violations map to the field error "Nama sudah
  dipakai di kategori ini".
- `getExpenseCategoryCatalog(db)`: one cached read (`unstable_cache`/`cache` keyed per request,
  invalidated through `admin-revalidate.ts`) returning categories and active items. Every reader
  below uses it instead of the constants.
- `lockSelectableExpenseCategoryAndItem(tx, code, itemId)`: `SELECT … FOR SHARE` on the category
  (and item), requiring `is_active`. Same race-safe pattern as `lockSelectableProductType`.

**Removing the constants as logic carriers.** `BusinessExpenseCategory` becomes `string` (codes);
`SYSTEM_EXPENSE_CATEGORY_CODES` (`ads_meta`…`other`) stays as a typed constant for the few code
paths that name one.

- `figures.ts`: `expenseChannelRule(category: {kind, fixedChannelId})`. `summarizeMarketing`
  takes rows carrying `kind` (the queries join `expense_categories`).
- `summary.ts`: group by category, join for name, kind and `sort_order`; sort by amount, then
  `sort_order`.
- `report-content.ts` / `report-xlsx.ts`: labels from the catalog. XLSX gets an "Item" column. The
  P&L detail lines stay **per category**, so new categories appear automatically.
- `search-params.ts`: the `category` param is validated against the catalog codes; the `group` tab
  derives from kind. The list's `q` also matches the item name.
- `expense-list.tsx`: shows "Kategori · Item" (item omitted when NULL, as for historical rows).
- Monthly bills: `/settings` offers **every active category** (D3) with labels from the catalog;
  `parseMonthlyBillCategories` validates against the catalog. The reminder ignores an inactive
  category; the Overview link picks the "Operasional" tab when every missing category has kind
  `operating`.
- `activity-log/fields.ts`: add `itemId: "Item biaya"`. The diff shows the code/uuid as today; a
  label lookup for `category`/`itemId` values is a nice-to-have, not required.

**Record form** (`record-expense-button.tsx`, `actions.ts`, `records.ts`). After the menu split
(§3.8), the same component is mounted twice with a `scope`: "Catat iklan" on Iklan offers kinds
`ad` + `endorsement`, and "Catat biaya" on Biaya offers kind `operating`. The server action
re-checks the category's kind against the scope it was posted from.

1. "Kategori": the scope's active categories, in `sort_order` (on Iklan, under an "Iklan" optgroup
   per D2; data passed from the server page; the client never queries).
2. "Item biaya": a select filtered to the chosen category's active items. It resets when the
   category changes. If the item has a `default_amount` and "Jumlah" is still empty, Jumlah is
   pre-filled (editable).
3. Free text: **no free-text item** (D1). The note stays free text. Rules:
   - Category has ≥ 1 active item → item **required** ("Pilih item biaya.").
   - Category has no items → the item field is hidden. `other` still requires a note.
   - The hint under the select: "Item tidak ada di daftar? Tambahkan di Data Master → Kategori
     Biaya." (a link only when the user can manage master data).
4. Server: zod `category: z.string()`, `itemId: z.string().uuid().optional()`. In the transaction,
   `lockSelectableExpenseCategoryAndItem` before insert, then the "item required when the category
   has active items" rule (checked under the same lock), then the channel rule from the category
   row. The composite FK and the channel trigger are the DB backstops.

### 3.6 Data Master pages

One nav entry, consistent with "Jenis Produk" (`apps/admin/src/lib/nav/config.ts`, group "Data
Master"):

| Route | Content |
|---|---|
| `/expense-categories` | List (CardList < md, TableContainer ≥ md): name, jenis (Iklan/Endorse/Operasional), items (count), dipakai (expense count), status, "Sistem" badge. Filter Aktif/Nonaktif/Semua. "Tambah kategori". |
| `/expense-categories/new` | Name, jenis (radio), urutan. Code generated, shown after save. |
| `/expense-categories/[code]` | Edit name and order; kind and code read-only; Nonaktifkan/Aktifkan (hidden and refused for system). Below: **Item biaya** section: list (both layouts), "Tambah item" dialog (name, catatan, jumlah default, urutan), edit dialog, Nonaktifkan/Aktifkan per item. |

- **No delete** for categories or items, used or not (same as Jenis Produk: the simplest way to
  meet "no delete once used").
- Deactivated: hidden from the record form and the `/settings` options; still shown on past
  expenses, filters (marked "(nonaktif)") and reports.
- Audit (`activity-log/catalog.ts`, area `expenses`):
  - `expense_category`: create/update/activate/deactivate ("Kategori biaya dibuat" …)
  - `expense_item`: create/update/activate/deactivate ("Item biaya dibuat" …)
  - Written in the same transaction as the change (`writeAuditLog`), with before/after diffs.
- Labels: "Kategori Biaya" (nav), "Item biaya", "Jenis: Iklan / Endorse / Operasional", "Sistem"
  badge tooltip "Dipakai perhitungan ROAS/laporan, tidak bisa dinonaktifkan".

### 3.7 Permissions (decided, D5)

**No new key.** The Data Master pages, both new menus, the Pengeluaran produksi tab and the cash
summary all require `ads_expenses.manage` + `finance.view_profit`, the same pair as recording an
expense today (owner, Keuangan, super_admin). The checks run on every page, server action, route
handler and read (`requireAllPermissions`), and the nav entries use the same keys. Nothing changes
in `permissions`/`role_permissions`, so no RBAC reference data is needed in a migration.

### 3.8 Menu split: "Iklan" and "Biaya"

Both menus stay in nav group "Pertumbuhan" (where "Iklan & Biaya" is today), with the same
permission pair. The routes are English, per CLAUDE.md:

| Menu | Route | Tabs | Record button |
|---|---|---|---|
| **Iklan** (icon Megaphone) | `/ads` | **Catatan iklan** (default): list of expenses with kind `ad` + `endorsement`, filters month/range, category, channel, voided, q. **ROAS** (`?tab=roas&period=…`): biaya pemasaran (iklan + endorse), ROAS per channel, Titik impas ROAS | "Catat iklan" |
| **Biaya** (icon Receipt) | `/expenses` | **Biaya operasional** (default): kind `operating` expenses, same filters minus channel. **Pengeluaran produksi** (`?tab=production`, §3.9, read-only). **Laba rugi** (`?tab=pnl&period=…`): today's P&L to Laba bersih plus "Unduh laporan bulanan" | "Catat biaya" |

The cash-out summary (§3.10) sits above the tabs of **Biaya** and follows the selected month.

**Endorse/KOL goes to Iklan** (decided, D7). It uses the same fields as ads (optional channel,
campaign), it is already reported next to ads as "Biaya pemasaran", and in the P&L it is a detail
line like any other category. Putting it under Biaya would need channel/campaign on the operating
form for a single category. It stays **outside ROAS** exactly as today (`kind = endorsement`).

**Laba rugi lives in Biaya** (decided, D8). It is the "what did everything cost" view, and the
download belongs with it. Iklan's ROAS tab shows the margin-based Titik impas next to ROAS, as
today. Both tabs call the same `getExpenseSummary`, so **every number is identical** to today's
Ringkasan, and `report-content`/`report-pdf`/`report-xlsx` are unchanged apart from the Item
column.

**Report route:** `/expenses/report` (new home). `/ads-expenses/report` stays as a thin route
handler that 308s to `/expenses/report` with the query string unchanged.

**Redirects (all old URLs keep working).** `/ads-expenses` becomes a server page that only
redirects (308, `permanentRedirect`), after the same permission check, because the target depends
on query values that `next.config.ts` `redirects()` cannot map:

| Old | New |
|---|---|
| `/ads-expenses?tab=ringkasan&…` | `/expenses?tab=pnl&…` (period params carried over) |
| `/ads-expenses?group=marketing&…` | `/ads?…` |
| `/ads-expenses?group=operational&…` | `/expenses?…` |
| `/ads-expenses?category=<code>&…` | `/ads` or `/expenses` by the category's kind |
| `/ads-expenses?q=BYA-…` (activity log) | look up the expense's category kind → `/ads?q=` or `/expenses?q=`; unknown → `/expenses?q=` |
| `/ads-expenses` (anything else) | `/expenses` |
| `/iklan-biaya` | `next.config.ts` destination changed to `/expenses` (one hop) |

New links are written directly: the Overview Laba bersih tile → `/expenses?tab=pnl`, the
monthly-bill reminder → `/expenses` (or `/ads` when every missing category is an ad category),
and activity-log entries → `/ads` or `/expenses` by kind. The `group` param and the
Semua/Iklan/Operasional tabs disappear; the menu is the group. `revalidateAdmin` gets `/ads` and
`/expenses`. The nav `rootCrumbs` derive from the config.

### 3.9 "Pengeluaran produksi" tab (read-only, Biaya)

Cash actually paid out for production, read live from `supplier_payments`. There is **no new table
and no copy**, so nothing can be entered twice, and nothing on the tab is editable.

- **Rows:** non-voided `supplier_payments` with `paid_at` in the selected month (Jakarta calendar
  dates, the same month picker as the summary). Optional filter Sumber: Semua / Pembelian /
  Produksi, and `q` (payment no, PO/batch no, supplier).
- **Columns** (CardList < md, TableContainer ≥ md):
  - Tanggal bayar, No. pembayaran
  - **Kategori:** fixed label "Biaya produksi"
  - **Item:**
    - Purchase → "Biaya bahan baku", with a detail derived from the PO's line types: "Kain",
      "Aksesoris" or "Kain & aksesoris".
    - Batch → the `component_name`s of that payee's lines on that batch, distinct, in line
      order, joined with ", " (e.g. "Ongkos jahit, Finishing"). Fallback: "Ongkos produksi".
  - Pemasok/penerima: `supplier_name` snapshot, or "Tanpa penerima"
  - **Pembayaran ke-n** (D9): the payment's position among that target's **non-voided**
    payments (per PO; per batch + payee for a batch), ordered by `paid_at`, `created_at`,
    `payment_no`. The order is stable because rows are append-only, and voided payments are not
    counted. There is **no per-payment "DP"/"Pelunasan"**.
  - **Status tagihan** (separate badge, D9): the bill's **current** status, from `status.ts`
    (`summarizePayment` over `purchaseTagihan` / `batchTagihan` per payee) with
    `PAYMENT_STATUS_LABELS`: "DP" (partial), "Lunas", "Lebih bayar". It is the same badge the
    PO and batch pages show, so the two always agree.
  - Metode, Jumlah
  - **Sumber:** PO no or batch no, linked to `/purchases/[id]` or `/production/[id]` **only when the
    viewer holds that page's permission** (`inventory.view` / `production.manage`). Otherwise
    plain text, so Keuangan never gets a link that 403s.
- **Banner** (always visible, not dismissible): "Ini pembayaran untuk stok bahan dan ongkos
  produksi. Tidak mengurangi laba bersih lagi: biayanya masuk laporan laba rugi sebagai HPP saat
  barangnya terjual."
- Footer total for the month. Voided payments are excluded (no toggle; the source pages still show
  them struck through).
- Query in `lib/expenses/production-outflows.ts`: one select over `supplier_payments` joined to
  `purchases`/`production_batches`, using index `supplier_payments_paid_at_idx` (range on
  `paid_at`, filter `voided_at IS NULL`), plus batched lookups for item labels, the
  payment ordinal and the bill status over the **targets on the current page only** (no N+1). Paginated like the other
  lists.

### 3.10 Cash-out summary (top of Biaya)

For the selected month (default this Jakarta month, the same `month` param as the tabs), three
tiles and a total:

| Line | Source | Rule |
|---|---|---|
| Biaya operasional | `business_expenses` kind `operating` | non-voided, `expense_date` in month |
| Pengeluaran produksi | `supplier_payments` | non-voided, `paid_at` in month |
| Iklan & endorse | `business_expenses` kind `ad` + `endorsement` | non-voided, `expense_date` in month |
| **Total uang keluar** | sum of the three | |

Heading "Arus kas keluar bulan ini", with the subtitle "Informasi arus kas, bukan laba. Laba
bersih ada di tab Laba rugi." The tiles use the neutral brand colours (no olive/brick status
colour: this is not on or off target). Each tile links to its tab, or to `/ads` for Iklan.
`lib/expenses/cash-outflow.ts`: a pure `sumCashOutflow({operating, production, ads})` plus one
query function. "Saldo platform" payments are included (D10): they are money spent even though they
never left the bank. A footnote says: "Termasuk biaya yang dibayar dari saldo penjual
Shopee/TikTok."

### 3.11 Accounting guard: production payments never become expenses

Laba bersih = laba setelah biaya platform − subsidi ongkir situs − **business_expenses only**.
Purchase and production cost enters only as HPP of sold orders (`getPeriodTotals`). The new code
must not change that:

- `production-outflows.ts` and `cash-outflow.ts` are imported **only** by the Biaya page. The P&L
  path (`summary.ts` `getExpenseSummary`/`getExpenseBreakdown`/`getExpenseTotal`, `figures.ts`,
  `report*.ts`) never reads `supplier_payments`.
- "Biaya produksi" is a **display label**, not an `expense_categories` row, so it can never be
  selected, summed into `byCategory`, picked as a monthly bill, or shown as a P&L detail line. The
  migration and the catalog forbid the code/name `biaya_produksi`/"Biaya produksi" (CHECK on
  `code`; app-level reserved-name check on `name`) so an owner-made category cannot collide with
  it.
- Tests (S2 baseline, S6 extended): see §4.

### 3.12 As built in S6 (final state)

- **Pengeluaran produksi** (`/expenses?tab=production`): `lib/expenses/production-outflows.ts`
  (query) and `lib/expenses/production-outflow-rows.ts` (pure rules: labels, numbering, status,
  links). Params `month` (default this Jakarta month), `source` (`purchase` / `production`), `q`
  (payment no, PO no, batch no, payee), `page`/`perPage`. Columns as §3.9; the item shows its
  detail in brackets ("Biaya bahan baku (Kain & aksesoris)"). Batch component names are in the
  batch page's line order (`created_at`, `id`); lines saved in one statement share `created_at`,
  so their relative order follows the id, exactly as on the batch page. The status badge is the
  shared `PaymentStatusBadge`; a purchase's tagihan comes from `purchaseLineTagihanSql` (pinned to
  `purchaseTagihan` by purchase-payments.test.ts), a batch payee's from `batchTagihan`.
- **Arus kas keluar**: `lib/expenses/cash-outflow.ts` (one aggregate over `business_expenses` by
  kind, plus `getProductionOutflowTotal`) and the pure `cash-outflow-sum.ts`. The heading names the
  month ("Arus kas keluar Februari 2026") instead of "bulan ini", because it follows the tab below
  it (`cashSummaryMonth`): the list's month (or the last month of its `from`/`to` window), the
  production tab's month, or the last month of Laba rugi's period.
- **Accounting guard**: behavioural in `summary.test.ts` (S2 baseline + S6 extended: Laba bersih,
  `expenses`, P&L lines, ROAS, Titik impas, `getMonthlyReport` and its Excel sheets, and the
  Overview tile are identical with and without the month's supplier payments, while
  `getCashOutflow` and `listProductionOutflows` include them), and static in
  `accounting-guard.test.ts` (the profit-path modules never name `supplier_payments`, and only the
  two Biaya components import the cash-flow readers).
- **Follow-ups from S5**: the monthly-bill reminder shows one link per menu holding a missing
  category ("Catat di Biaya", then "Catat di Iklan"; `lib/expenses/monthly-bill-links.ts`), and the
  activity-log area is labelled "Iklan dan Biaya".
- e2e: `expenses-production.spec.ts` (390px and 1280px) on a February 2026 fixture seeded in
  `global-setup.ts` (PO-E2E-KAS with DP, a voided payment and pelunasan; BTC-E2E-KAS paid once).

---

## 4. Sessions

One feature per session. Each ends with `pnpm typecheck && pnpm lint`, the unit tests and e2e
specs listed, `/code-review` (typescript-reviewer, react-reviewer for `.tsx`, database-reviewer
for S1/S2/S6 queries) and the owner committing. Every list-page e2e asserts at **390px
(CardList) and 1280px (TableContainer)**. DB tests run against `ammari_e2e`/a scratch database,
never `ammari`.

**S1: DB migration 0048** (`packages/db`)
- Schema: `expense_categories`, `expense_items`, `business_expenses.item_id` with the composite
  FK, the category FK, dropping the category CHECK and the monthly-bill subset CHECK, replacing the
  channel CHECK with the insert trigger, and the code/kind immutability trigger. Reserved code
  `biaya_produksi` (CHECK). Seed rows in the migration and in `seed.ts` (insert-only). Run
  `db:generate`, hand-append the triggers and seeds, and **read the SQL**.
- `packages/db/test/migration-0048.test.ts`:
  - Upgrading a 0047 DB with expenses in all ten categories maps them 1:1, `item_id` is NULL,
    and the append-only trigger is intact.
  - Old-release inserts behave exactly as before, including the channel verdicts of the dropped
    CHECK.
  - A new `ad` category takes an optional channel; a new `operating` one refuses a channel.
  - An item from another category is refused by the FK.
  - A system category cannot be deactivated and cannot change code or kind.
  - A used category or item cannot be deleted.
  - Re-running the migration is a no-op.

**S2: Reports and ROAS on the new tables** (no visible UI change)
- `lib/expense-categories/queries.ts` (catalog read, category and item CRUD, the lock helper)
  with integration tests.
- `figures.ts`, `summary.ts`, `records.ts`, `search-params.ts`, `report-content.ts`,
  `report-xlsx.ts`, `labels.ts`, the monthly bills (any active category, D3) and the overview
  reminder read the catalog and `kind`.
- Tests:
  - Existing `figures`/`summary`/`report*`/`search-params`/`records`/settings tests keep passing
    with **identical numbers**.
  - A user-created `ad` category counts in ROAS.
  - A new `operating` category appears in the P&L detail and in Laba bersih.
  - An inactive category drops out of the reminder.
  - **Accounting guard (baseline):** seed non-voided purchase and batch payments in the period.
    `getExpenseSummary` (`net`, `expenses.total`, `byCategory`, `marketing`, `roasRows`,
    `breakEven`), `getExpenseTotal` and `profitAndLossLines` are byte-identical to the same fixture
    without those payments.
- No e2e change (screens identical). The existing `ads-expenses*.spec.ts` must stay green at
  390/1280.

**S3: Data Master pages**
- `/expense-categories`, `/new` and `/[code]` with the item section (add, edit, deactivate and
  reactivate dialogs, optional default amount), server actions, the nav entry "Kategori Biaya",
  and audit catalog entries `expense_category`/`expense_item`.
- Tests:
  - `actions.test.ts`: permission refusals, unique name → field error, system deactivate refused,
    reserved name "Biaya produksi" refused, audit rows written.
- e2e `expense-categories.spec.ts` at 390 and 1280:
  - The list renders in both layouts.
  - Create "Langganan" (Operasional), add Biteship Grow / Claude / VPS (VPS with a default
    amount), rename one item, deactivate another.
  - A system category shows no Nonaktifkan.
  - A role without `ads_expenses.manage` gets 403 and sees no nav entry.

**S4: Expense form with items** (still on `/ads-expenses`)
- Category → item select (required when the category has active items, hidden when it has none),
  default amount prefill, server lock and validation, the list shows "Kategori · Item", and `q`
  matches the item name. The `scope` prop exists but `/ads-expenses` passes "all".
- Tests in `records.test.ts`/`actions.test.ts`:
  - An item from another category is refused.
  - An inactive item or category is refused.
  - A category without items needs no item.
  - `other` still needs a note.
  - Item required when the category has items.
- e2e `ads-expenses.spec.ts` at 390 and 1280:
  - Record "Langganan → VPS" (amount prefilled) and see it in both list layouts.
  - The item resets when the category changes.
  - A deactivated item is not offered, but past expenses still show it.

**S5: Menu split + redirects**
- `/ads` (Catatan iklan, ROAS), `/expenses` (Biaya operasional, Laba rugi), the `scope` per menu
  with a server-side kind check, `/expenses/report`, `/ads-expenses` and `/ads-expenses/report`
  as redirectors, `next.config.ts` `/iklan-biaya` → `/expenses`, two nav entries replacing one,
  new hrefs in the Overview, the reminder, the activity log and `revalidateAdmin`. The XLSX "Item"
  column.
- Tests:
  - Unit: `search-params` (new hrefs, kind-scoped category param); the redirect mapping as a pure
    function, covering every row of the §3.8 table including `q=BYA-…` lookup by kind; the server
    action refuses an `operating` category posted from Iklan and an `ad` one from Biaya.
  - The report route test moves and still asserts the same bytes for a fixture.
- e2e (390 and 1280):
  - `ads.spec.ts`: Iklan lists only ad and endorse rows; ROAS tab figures equal the fixture.
  - `expenses.spec.ts`: Biaya lists only operating rows; Laba rugi equals today's Ringkasan
    fixture, and the PDF/XLSX download works.
  - `ads-expenses-redirects.spec.ts`: old URLs (`?tab=ringkasan&period=month&month=…`,
    `?group=marketing`, `?q=BYA-…`, `/iklan-biaya`, the old report URL) land on the right page.
  - The nav shows "Iklan" and "Biaya", not "Iklan & Biaya".
  - Rename `ads-expenses*.spec.ts` to these files.

**S6: Pengeluaran produksi tab + cash summary**
- `lib/expenses/production-outflows.ts`, `lib/expenses/cash-outflow.ts`, the tab, the banner, the
  summary tiles, and permission-aware source links.
- Tests:
  - Unit/integration:
    - Month boundaries in Jakarta.
    - Voided payments excluded.
    - Purchase item detail Kain / Aksesoris / both.
    - The batch item joins only that payee's components.
    - "Pembayaran ke-n" skips voided payments and counts per batch + payee; the status badge
      matches the PO/batch page (DP, Lunas, Lebih bayar after a purchase is closed short).
    - The source link is omitted without `production.manage`.
    - `sumCashOutflow` arithmetic.
  - **Accounting guard (extended):** for one fixture month holding operating, ad, endorse,
    purchase and batch payments:
    - Cash total = operating + production + ads.
    - Laba bersih, `expenses.total`, the P&L lines and the PDF/XLSX P&L contain no production
      payment and no "Biaya produksi" line.
    - ROAS and Titik impas are unchanged by adding or removing the supplier payments.
    - The Overview Laba bersih tile is unchanged.
- e2e `expenses-production.spec.ts` at 390 and 1280:
  - The tab lists the seeded purchase and batch payments with the right item labels and source
    numbers, and the banner is visible.
  - No edit or void controls exist.
  - The voided payment is absent.
  - The summary tiles and total match the fixture.
  - The Laba rugi tab's Laba bersih equals the value before the supplier payments were seeded.

---

## 5. Decisions

### Decided by the owner (2026-11-26)

- **D1:** No free-text item. Pick from the list; details go in Catatan.
- **D2:** Keep Iklan Meta/TikTok/Shopee as three system categories, grouped under an "Iklan"
  heading. The owner creates "Langganan" and its items himself; nothing is pre-created.
- **D3:** Any active category can be marked "wajib dicatat tiap bulan".
- **D4:** Optional default amount per item (prefills Jumlah, always editable).
- **D5:** Same permissions as recording expenses (`ads_expenses.manage` + `finance.view_profit`).
- **D6:** Renames change how past expenses and reports read. Accepted.

- **D7:** Endorse/KOL goes under **Iklan** and stays excluded from ROAS.
- **D8:** The Laba rugi tab and the monthly PDF/Excel download live in **Biaya**.
- **D9:** Pengeluaran produksi rows show "Pembayaran ke-n" (stable order per PO, or per batch and
  payee; voided payments excluded from the numbering) plus the bill's **current** status as a
  separate badge (DP / Lunas / Lebih bayar). There is no per-payment "DP"/"Pelunasan".
- **D10:** Payments from the Shopee/TikTok seller balance count in "Total uang keluar", with a
  footnote.
- **D11:** Both menus stay in "Pertumbuhan"; Megaphone icon for Iklan, Receipt icon for Biaya.

No decision is open.
