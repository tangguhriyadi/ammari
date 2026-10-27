# Peran & Staf (`/roles-staff`): staff accounts and roles

Status: **owner decisions recorded 2026-10-27 (§12). Sessions S1 to S4 built** (migration
`0041_staff_invites`, admission/landing changes, `apps/admin/src/lib/staff/mutations.ts`,
`role-mutations.ts`, `queries.ts`, and the `/roles-staff` Staf and Peran tabs with staff and role
pages). S5 (onboarding, ops only) not started.

Goal: the owner (super_admin) can add his wife (co-owner) and limited staff (packing/gudang,
konten, CS/pesanan, keuangan) himself, from the admin UI, without the seed script or SQL.

---

## 1. What exists today (investigation)

**Auth (SPEC §10.1, `packages/auth/src/staff/*`, `apps/admin/src/lib/auth/*`)**

- Better Auth staff instance, Google + email OTP, no passwords, no self sign-up.
- Admission is keyed on `staff_users.email` (citext, unique) with `is_active = true`:
  `user.validateUserInfo` and `databaseHooks.user.create.before` both call
  `loadActiveStaffForEmail()`; `databaseHooks.session.create.before` re-checks `is_active` via
  `isActiveStaffAuthUser()` on every new session; `session.create.after` sets `last_login_at`.
- `staff_auth_users` links 1:1 to `staff_users` (`staff_user_id` NOT NULL UNIQUE, ON DELETE
  RESTRICT) and is created by Better Auth on the person's **first** login. So "invite" already
  works in principle: a `staff_users` row is the invitation. There is no invite table, no expiry.
- `getStaffSession()` re-derives role, permissions and `is_active` from the DB on **every
  request** (`loadStaffSessionData`), no cookie cache. Consequence: deactivation and role changes
  already take effect on the person's next request. Deleting their `staff_auth_sessions` rows is
  defence in depth and makes "logged out everywhere" literally true.
- How staff are created today: only `packages/db/src/seed.ts` (`SEED_SUPER_ADMIN_*`,
  `SEED_OWNER_*`), insert-only, run by hand (docs/deploy-prod.md §10, docs/deploy.md). §10
  already says the wife's account should be created through `/roles-staff`.

**RBAC (`packages/db/src/rbac/permissions.ts`, `schema/rbac.ts`, SPEC §9)**

- 22 permission keys in code; `permissions`, `roles` (`key`, `name`, `description`,
  `is_system`), `role_permissions`, `staff_users.role_id` (exactly one role).
- System roles: `super_admin` (all keys) and `owner` (all except
  `OWNER_EXCLUDED_PERMISSION_KEYS`, which was `roles.manage`, `staff.manage`, `audit_log.view`
  before this feature; `staff.manage` left it in 0041, owner answer 2).
- No application code matches a role by key (only seed). All checks are by permission key.
- **Trap found:** `seed.ts`'s `upsertSystemRole` re-syncs `owner` (and `super_admin`) role
  permissions on every run, **pruning anything not in the default list**. Once super_admin can
  edit the owner role from the UI, a later hand-run of `seed.ts` (deploy-prod.md §10 recovery)
  would silently undo those edits. Must change (§9).

**Enforcement**

- `requirePermission` / `requireAnyPermission` / `requireAllPermissions` in every page and
  action; `proxy.ts` is a coarse session gate only. Nav is `lib/nav/config.ts` filtered by
  permission (cosmetic). Field-level hiding via `session.permissionKeys.includes(...)`, e.g. every
  cost/profit figure behind `finance.view_profit`.
- Packing "Tandai dikirim" (`markShippedAction`, bulk too) needs `orders.manage`, not
  `packing.print_cards`. Receiving goods needs `inventory.receive` + `inventory.view`; receiving a
  production batch needs `inventory.receive` + `production.manage`.
- `content.manage` can edit a product's publish/description/size chart through the product form
  (`requireAnyPermission(["products.manage","content.manage"])`), but the **product list page
  and nav item require `products.manage`**, and photo upload/reorder/delete require
  `products.manage`. A content-only role currently cannot find products.
- `vouchers.void` is in the catalog but no action uses it yet.
- **Trap found:** after login both Google and OTP send the user to `/`, which requires
  `overview.view`. A role without it (e.g. Packing) lands on a 403 right after logging in.

**Audit log**: `audit_log` (`actor_staff_user_id`, `action`, `entity_type`, `entity_id`,
`before`, `after` jsonb); `writeAuditLog(tx, …)` in `@ammari/commerce/db` (re-exported by
`@/lib/db`). `/activity-log` is still "coming soon".

---

## 2. Scope

In:
1. Staff list + staff detail, invite by email, change role, edit name, deactivate / reactivate,
   "Akhiri semua sesi", resend/renew invitation.
2. Roles list + read-only permission matrix for everyone with `staff.manage` or `roles.manage`;
   matrix **editing** and **custom roles** for `roles.manage` (super_admin only by default).
3. Four predefined roles shipped by migration.
4. Guard rails in the app and in the database.
5. Audit log rows for every change.
6. `/` redirects to the first permitted page when the user lacks `overview.view`.

Out (separate features): `/activity-log` page; per-staff device/session list beyond a count;
splitting `orders.manage` into a narrower "mark shipped" key (answer 4); hard delete of anything.

---

## 3. Data model and migration (0041, backward compatible)

All additive. The currently deployed release never reads the new columns, so rollback stays safe.

```
staff_users
  + invited_at                 timestamptz NULL
  + invite_expires_at          timestamptz NULL   -- NULL = no expiry (every existing row)
  + invited_by_staff_user_id   uuid NULL REFERENCES staff_users(id) ON DELETE RESTRICT
  + deactivated_at             timestamptz NULL
  + CHECK (invite_expires_at IS NULL OR invited_at IS NOT NULL)
```

- **No separate invite table.** A `staff_users` row is already the admission record; a second
  table would duplicate email uniqueness and the admission gate. Status is derived:

  | Status (UI) | Rule |
  |---|---|
  | `Aktif` | `is_active` and `last_login_at IS NOT NULL` |
  | `Undangan` | `is_active`, never logged in, `invite_expires_at` NULL or in the future |
  | `Undangan kedaluwarsa` | `is_active`, never logged in, `invite_expires_at <= now()` |
  | `Nonaktif` | `NOT is_active` |

- **Predefined roles** inserted by the migration (`is_system = false`, so they stay editable),
  each `INSERT ... ON CONFLICT (key) DO NOTHING`, and their `role_permissions` with
  `ON CONFLICT DO NOTHING` (only when the role row was just inserted, via a CTE on the role
  insert's `RETURNING`, so a role the owner already edited is never re-granted). Keys:
  `packing_warehouse`, `content_admin`, `customer_service`, `finance`. Exact grants in §6.
- **Owner gets `staff.manage`** (owner answer 2): idempotent grant, plus the owner role's
  description is rewritten only if it still has the seeded text.
- **Database backstop for the last super_admin** (built): `prevent_last_super_admin_loss`, a
  `CONSTRAINT TRIGGER ... AFTER UPDATE OF is_active, role_id ON staff_users DEFERRABLE INITIALLY
  DEFERRED FOR EACH ROW`. If the OLD row was an active `super_admin` and, at commit, no active
  super_admin remains, it raises. It first takes the same advisory lock as the app
  (`pg_advisory_xact_lock(hashtext('ammari.staff_access'))`, `STAFF_ACCESS_LOCK_KEY`), so two
  concurrent transactions each removing a different super_admin can't both commit (write skew;
  covered by a two-connection test). Row triggers do not fire on `TRUNCATE`, so `e2e-db.ts`
  resets are unaffected. **The last-owner rule is app-only** (deviation from the first draft):
  losing the last owner is recoverable by a super_admin, and a DB trigger for it would also trip
  existing auth tests that deactivate a lone owner fixture. The app checks both first (§5) so
  users see Indonesian errors, not a raw exception. Review changes (DELETE, isolation guard,
  pending invites not counted): §11a.
- No change to `roles` (no `is_active`, no delete in v1, answer 7).
- `drizzle-kit generate` for the columns; the trigger, role rows and grants are hand-appended SQL.
  Read the generated file before committing (CLAUDE.md).

**Admission gate change** (`packages/auth/src/staff/staff-data.ts`): `loadActiveStaffForEmail`
and `isActiveStaffAuthUser` additionally reject `last_login_at IS NULL AND invite_expires_at <=
now()`. One predicate, both functions, so the OTP send path, Google, and first session all agree.
An expired invite looks exactly like an unknown email (same generic error, no email sent).
During the one-deploy overlap an older release ignores expiry; acceptable.

---

## 4. Pages and UI (apps/admin, Indonesian, phone first, no em dash in UI text)

Route stays `/roles-staff` with two tabs: **Staf** and **Peran** (`?tab=peran`). Tab visibility:
Staf needs `staff.manage`; Peran is visible with `staff.manage` (read-only, to understand what a
role grants before assigning it; this is what the owner sees) or `roles.manage` (editable,
super_admin only, owner answer 1).

### 4.1 Staf (list)

- Phone: `CardList` cards. Tablet/desktop: `TableContainer` table (both layouts, per CLAUDE.md).
- Columns: Nama, Email, Peran, Status badge (muted tones: olive for Aktif, neutral for Undangan,
  brick for Nonaktif / Undangan kedaluwarsa), Terakhir masuk ("Belum pernah masuk" or
  `27 Okt 2026, 14.05` in Asia/Jakarta).
- Filter chips: Semua / Aktif / Undangan / Nonaktif. Sort: active first, then name.
- "(Anda)" marker on the viewer's own row.
- Primary button "Undang staf".

### 4.2 Undang staf (sheet on phone, dialog on desktop)

Fields: Nama, Email, Peran (select showing role name + one-line summary + "Bisa lihat laba"
badge if the role has `finance.view_profit`). Helper text: "Staf masuk dengan Google atau kode
lewat email, memakai alamat email ini persis." Submit "Kirim undangan".

Success: "Undangan dibuat. Berlaku sampai 3 Nov 2026." If the email send failed: "Undangan
dibuat, tapi email gagal terkirim. Minta staf membuka admin.ammari.id dan masuk dengan email ini."
(The email is a convenience; the row is the invitation.)

### 4.3 Staf detail (`/roles-staff/staff/[id]`)

- Header: name, email, status, role, Diundang oleh / pada, Terakhir masuk, Sesi aktif: N.
- Actions (each hidden and server-refused when not allowed, §5):
  - Ubah nama.
  - Ubah email: **only while never logged in** (fix a typo). After first login the email is
    bound to `staff_auth_users`/Google; to change it, deactivate and invite the new address.
  - Ubah peran (select + confirm sheet: "Perubahan berlaku langsung.").
  - Nonaktifkan (confirm: "Staf ini langsung keluar dari semua perangkat dan tidak bisa masuk
    lagi."), Aktifkan kembali.
  - Akhiri semua sesi (lost phone case, account stays active).
  - Kirim ulang undangan (state Undangan / Undangan kedaluwarsa): resets `invite_expires_at` to
    now + 7 days and re-sends the email.
- "Riwayat" (last 20 audit rows for this staff user) shown only if the viewer has
  `audit_log.view`.

### 4.4 Peran

- List of roles: name, description, staff count (active), "Sistem" badge for super_admin/owner.
- Role detail `/roles-staff/roles/[id]`: permission matrix grouped by area, Indonesian labels,
  one row per permission with a plain-language description; sensitive permissions carry a
  "Sensitif" badge and a one-line warning.
- With `roles.manage`: checkboxes + "Simpan perubahan" (single save, one audit row), rename,
  edit description, "Buat peran" (blank or "Salin dari peran ini"). `super_admin` is always
  read-only ("Super Admin selalu punya semua izin."). Unsaved-changes guard
  (`use-unsaved-changes-guard.ts`).

Indonesian labels (new `apps/admin/src/lib/staff/permission-labels.ts`, typed
`Record<PermissionKey, …>` so a new key fails the typecheck until labelled):

| Area | Key | Label | Sensitive |
|---|---|---|---|
| Ringkasan | `overview.view` | Lihat ringkasan penjualan | |
| Pesanan | `orders.view` | Lihat pesanan | |
| Pesanan | `orders.manage` | Catat pesanan manual, ubah status, tandai dikirim, booking kurir | |
| Pesanan | `orders.import` | Impor file Shopee/TikTok | |
| Packing | `packing.print_cards` | Buka antrean packing, cetak kartu dan stiker | |
| Stok | `stock.view` | Lihat stok produk | |
| Stok | `stock.adjust` | Koreksi stok manual | |
| Produksi | `production.manage` | Kelola batch produksi | |
| Produk | `products.manage` | Kelola produk, varian, harga, foto, bahan, jenis produk | |
| Bahan & Pembelian | `inventory.view` | Lihat stok bahan/aksesoris, supplier, pembelian | |
| Bahan & Pembelian | `inventory.manage` | Kelola supplier dan dokumen pembelian, koreksi, cacat | |
| Bahan & Pembelian | `inventory.receive` | Terima barang datang | |
| Keuangan | `finance.view_profit` | Lihat HPP, laba, biaya, dan pencairan | **Ya** |
| Keuangan | `supplier_payments.manage` | Catat/batalkan pembayaran supplier, lihat bukti bayar | **Ya** |
| Keuangan | `ads_expenses.manage` | Catat biaya iklan dan pengeluaran | |
| Pelanggan | `customers.view` | Lihat data pelanggan | (data pribadi) |
| Pelanggan | `vouchers.void` | Batalkan voucher | |
| Konten | `content.manage` | Kelola beranda, halaman info, tabel ukuran, deskripsi produk | |
| Pengaturan | `settings.manage` | Ubah target, asumsi biaya, pengaturan | |
| Pengaturan | `staff.manage` | Kelola akun staf | **Ya** |
| Pengaturan | `roles.manage` | Kelola peran dan izin | **Ya** |
| Pengaturan | `audit_log.view` | Lihat log aktivitas | |

---

## 5. Server rules and guard rails

All in `apps/admin/src/lib/staff/*.ts` (queries) + `app/(shell)/roles-staff/actions.ts` (thin
actions: `requirePermission`, zod parse, `runAction`). Every mutation is one transaction that
starts with `pg_advisory_xact_lock(hashtext('staff_roles'))`, so concurrent staff/role edits are
serialized (this closes the write-skew where two admins demote the last two super_admins at the
same time) and the "last super_admin" check is not a check-then-write race. The DB trigger (§3)
is the backstop. Staff edits are rare, so one global lock costs nothing.

Permissions:
- Staff actions require `staff.manage`. Role edits require `roles.manage`.
- **No privilege escalation (subset rule):** an actor may assign a role, or act on a staff member
  whose current role is, only if that role's permissions are a subset of the actor's own. This
  makes "only a super_admin can grant or touch super_admin" fall out automatically now that the
  owner holds `staff.manage` (owner answer 2): she lacks `roles.manage`/`audit_log.view`, so
  super_admin is never a subset of her permissions. She can invite/manage owner and every
  predefined role. Built: `assertRoleWithinActor` in `lib/staff/mutations.ts`, run on the
  target's current role and on any role being assigned, with the actor's permissions re-read
  under the lock.
- With `roles.manage`, an actor may only grant permissions they hold themselves (same subset idea).

Refusals (server, Indonesian message):
- Self: cannot change own role, deactivate self, or end own sessions from this page
  ("Anda tidak bisa mengubah akun Anda sendiri di sini.").
- Last active `super_admin`: cannot be deactivated or moved to another role.
- Last active `owner` (once one exists): same.
- `super_admin` role permissions are not editable; removing `roles.manage`/`staff.manage` from
  every role a super_admin could hold is therefore impossible.
- (S4) Role permission edits need `roles.manage` (super_admin only); the `super_admin` role
  itself is never editable, so nobody can lock themselves out that way.
- Inviting an email that already has a row: "Email ini sudah terdaftar." with a link to that
  person (acceptable inside admin: anyone with `staff.manage` can already see the full list).
- Assigning a role is checked against the role id from the DB, not from the form's list.

Sessions:
- Deactivate: in the same transaction set `is_active = false`, `deactivated_at = now()`, and
  `DELETE FROM staff_auth_sessions WHERE user_id IN (SELECT id FROM staff_auth_users WHERE
  staff_user_id = $1)`. Their open tab fails on its next request regardless (live re-check).
- Role change: no session deletion. `getStaffSession` re-reads permissions every request, so the
  change is live without kicking the packer out mid-shift.
- Akhiri semua sesi: the same `DELETE`, nothing else.
- `staff_auth_accounts` (Google link) is kept on deactivation, so reactivation needs no new link.

Invites:
- `invited_at = now()`, `invite_expires_at = now() + 7 days` (answer 3), `invited_by_staff_user_id`.
- Email: plain Indonesian text via the existing `EmailSender` ("Anda diundang ke Admin Ammari
  sebagai {peran}. Buka https://admin.ammari.id lalu masuk dengan Google atau kode lewat email,
  memakai alamat ini."). No token, no magic link: login is still Google/OTP with that address,
  so the email carries no secret. Sent after commit; failure is recorded in the action result,
  never rolls back the row.
- Not using `auth_email_throttle` for invite emails: sharing it would trip the 60 s OTP cooldown
  for the invitee who tries to log in right after receiving the invite.

Login landing (built in S1, owner answer 6): `/` calls `requireOverviewOrRedirect()`
(`lib/auth/require-overview-or-redirect.ts`). Without `overview.view` it redirects to
`firstAllowedHref()` (`lib/nav/filter.ts`): first an allowed page from `LANDING_PRIORITY`
(`/packing`, then `/content`), else the first allowed nav item in catalog order. So Packing/Gudang
lands on `/packing` (catalog order alone would give `/orders`) and Admin Konten on `/content`. A
session that may open nothing gets the existing 403 page (no new UI).

Built details (S2): the rate limits are counted from `audit_log` (`staff.invite` +
`staff.invite_renew` rows) inside the advisory-locked transaction. Messages use "Anda". The invite
email goes through the same `EmailSender` as OTP emails (`staffEmailSender` exported from
`lib/auth/staff.ts`; the capturing no-op sender in e2e), with an idempotency key per invitation
window. A send failure is logged with `errorLogFields` (class name and code, never the message)
and audited as `staff.invite_email_failed` with `{reason: <error class>}`.

---

## 6. Predefined roles (recommended grants)

Sensitive keys marked **[S]**. ✓ = granted.

| Permission | Super Admin (suami) | Owner (istri) | Packing/Gudang | Admin Konten | CS/Pesanan | Keuangan |
|---|---|---|---|---|---|---|
| `overview.view` | ✓ | ✓ | | | ✓ | ✓ |
| `orders.view` | ✓ | ✓ | ✓ | | ✓ | ✓ |
| `orders.manage` | ✓ | ✓ | ✓ (answer 4) | | ✓ | |
| `orders.import` | ✓ | ✓ | | | | ✓ |
| `packing.print_cards` | ✓ | ✓ | ✓ | | | |
| `stock.view` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `stock.adjust` | ✓ | ✓ | | | | |
| `production.manage` | ✓ | ✓ | | | | |
| `products.manage` | ✓ | ✓ | | (answer 5) | | |
| `inventory.view` | ✓ | ✓ | ✓ | | | ✓ |
| `inventory.manage` | ✓ | ✓ | | | | |
| `inventory.receive` | ✓ | ✓ | ✓ | | | |
| `ads_expenses.manage` | ✓ | ✓ | | | | ✓ |
| `finance.view_profit` **[S]** | ✓ | ✓ | | | | ✓ |
| `supplier_payments.manage` **[S]** | ✓ | ✓ | | | | ✓ |
| `settings.manage` | ✓ | ✓ | | | | |
| `customers.view` | ✓ | ✓ | | | ✓ | |
| `vouchers.void` | ✓ | ✓ | | | | |
| `content.manage` | ✓ | ✓ | | ✓ | | |
| `staff.manage` **[S]** | ✓ | ✓ | | | | |
| `roles.manage` **[S]** | ✓ | | | | | |
| `audit_log.view` | ✓ | | | | | |

Notes:
- Owner = the existing system role plus `staff.manage` (owner answer 2, migration 0041).
  `OWNER_EXCLUDED_PERMISSION_KEYS` is now `roles.manage`, `audit_log.view`.
- Source of truth for the four predefined roles: `PREDEFINED_ROLES` in
  `packages/db/src/rbac/permissions.ts`, mirrored by hand in migration 0041 and checked by
  `migration-0041.test.ts`.
- Packing/Gudang: queue, cards/stickers, mark shipped, see stock, receive supplier deliveries.
  No costs anywhere (every cost is behind `finance.view_profit`). Cannot receive a production
  batch (needs `production.manage`); the owner does that.
- Admin Konten: storefront content and product descriptions. Needs the product-list fix (answer
  5, S4): open the list and edit content fields only; photos stay under `products.manage`.
- CS/Pesanan: WhatsApp/Instagram/offline orders, status, customers, stock availability. Sees
  revenue on Ringkasan (no profit). No voucher void, no import.
- Keuangan: everything money, read-only on operations; no product/stock edits.
- Any future permission key: migration grants it to `super_admin` and `owner` only (existing
  rule in `permissions.ts`); predefined/custom roles get nothing until someone ticks it.

---

## 7. Audit log

One row per user action, inside the same transaction. `entity_type` `staff_user` or `role`,
`entity_id` the uuid. `before`/`after` hold only the changed fields (never tokens, sessions,
OTPs).

| action | before / after |
|---|---|
| `staff.invite` | – / `{name, email, roleKey, inviteExpiresAt}` |
| `staff.invite_renew` | `{inviteExpiresAt}` / `{inviteExpiresAt}` |
| `staff.update` | `{name?, email?}` / `{name?, email?}` |
| `staff.role_change` | `{roleKey}` / `{roleKey}` |
| `staff.deactivate` | `{isActive: true}` / `{isActive: false, sessionsEnded: n}` |
| `staff.reactivate` | `{isActive: false}` / `{isActive: true}` |
| `staff.sessions_revoke` | – / `{sessionsEnded: n}` |
| `role.create` | – / `{key, name, permissionKeys, copiedFromRoleKey?}` |
| `role.update` | `{name?, description?}` / same |
| `role.permissions_update` | `{permissionKeys}` / `{permissionKeys}` (full sorted lists) |
| `staff.invite_email_failed` | – / `{reason}` (short code, no provider body) |

---

## 8. Security

- **Email normalisation:** trim, lowercase, NFC, zod `.email()`, max 254, reject any whitespace
  inside. Column is citext anyway. Do **not** strip Gmail dots or `+tags`: that would merge
  distinct addresses on other domains. The UI says the address must be the one they log in with.
- **No account enumeration at login:** unchanged. Not invited, expired invite, deactivated: all
  the same generic error, same OTP-send response and timing (existing `after()` path).
- **Typo protection:** invite expiry (7 days) limits how long a mistyped address that belongs to
  a stranger stays admissible. The invite email itself goes to that address, so a typo is
  noticed when the real person says "I got nothing".
- **Google:** confirm Better Auth's Google provider only admits a verified Google email
  (`email_verified`); if not enforced, reject in `validateUserInfo`. Verify in session 1 with a
  test, do not assume.
- **Rate limits on invites:** per actor max 20 invite/renew actions per hour, per target email
  max 1 invite email per 10 minutes. Counted from `audit_log` inside the advisory-locked
  transaction (so it is atomic, not check-then-write). Over the limit: "Terlalu banyak undangan.
  Coba lagi nanti." Invite emails also count toward nothing in `auth_email_throttle`.
- **Server-side everywhere:** every page and action calls `require*Permission`; ids from the
  client are re-read from the DB; the subset rule runs on the server.
- **super_admin vs owner:** `super_admin` is the "keys to the building" account (Tangguh only,
  owner answer 10): all permissions, the only one who can edit roles, see the audit log, and
  create or touch a super_admin. `owner` (the wife) runs the business: every business permission
  including profit and supplier payments, plus inviting and managing staff whose roles fit inside
  her own permissions; never roles, the audit log, or a super_admin. Never give super_admin to
  staff.
- Seed recovery stays as documented (deploy-prod.md §10) and is the only way back if every
  super_admin were lost; the trigger makes that state unreachable from the app.

---

## 9. Other code changes

- `seed.ts` (built): `upsertSystemRole` keeps fully syncing `super_admin` (always all keys); the
  owner role and the four predefined roles go through `insertRoleIfMissing` (role + grants only
  when the key is new; never renamed, re-granted or pruned), so super_admin's UI edits survive a
  manual seed run. Seed also restores the predefined roles after `e2e-db.ts`'s TRUNCATE.
- `docs/SPEC.md` §9 (owner bullet) updated with S1. The rest of §9 (predefined roles, subset rule,
  last-owner rule, invite expiry, session rules) and `docs/deploy-prod.md` §10 in S5.
- Nav: "Peran & Staf" unchanged. Content product-list fix in S4 (answer 5).

---

## 10. Tests

TDD is not mandated for this area by CLAUDE.md, but the guard rails and admission change are
security code: write them test-first anyway. Status after S1+S2: 1 to 11 built (6, concurrency,
is tested at the trigger level with two real connections in `migration-0041.test.ts`; the
app-level path takes the same lock); 7 and 11 are S4. E2E 13 (landing part) and the owner's nav
change are in `e2e/nav-rbac.spec.ts`; 12, 14 to 16 are S3/S4.

Unit / integration (vitest, real Postgres test db):
1. Migration 0041: columns nullable; predefined roles and grants inserted; re-running is a no-op;
   an edited predefined role is not re-granted; old-release-shaped insert into `staff_users`
   still works.
2. Trigger: deactivating / re-roling the last active super_admin raises at commit; same for last
   owner; fine when another active one exists; fine when no owner ever existed.
3. Admission (`packages/auth`): expired never-logged-in invite rejected for OTP send (no email,
   same response), OTP verify, Google; expired expiry ignored once `last_login_at` is set; NULL
   expiry admitted (existing rows).
4. Invite: normalises email; duplicate email refused; actor without `staff.manage` refused;
   subset rule refuses assigning `super_admin` by a non-super_admin; rate limits (21st in an hour,
   2nd email in 10 min); email failure keeps the row and logs `staff.invite_email_failed`.
5. Role change / deactivate: self refused; last super_admin refused with Indonesian message;
   deactivate deletes that user's sessions only; next `loadStaffSessionData` returns null;
   reactivate restores login; role change reflected in the next `loadStaffSessionData`.
6. Concurrency: two parallel demotions of the last two super_admins, exactly one succeeds.
7. Role permissions: super_admin role immutable; grant outside actor's set refused; one audit
   row with full before/after lists.
8. Audit rows for every action in §7.
9. `firstAllowedHref`: packing role goes to `/packing`; no permissions goes to the empty page.
10. Seed: running `seed()` twice does not prune an owner permission edit.
11. Label map covers every `PermissionKey` (compile-time, plus a runtime test).

E2E (Playwright, **390px and 1280px** for list pages):
12. super_admin invites a staff member, list shows "Undangan" in both layouts; invitee logs in
    with OTP, list shows "Aktif" and last login.
13. Change role to Packing/Gudang; that user's next navigation shows only the Packing menu set and
    `/` redirects to `/packing`.
14. Deactivate; the deactivated user's open session is sent to `/login`; login attempt gets the
    generic error.
15. Peran tab: matrix renders grouped labels and "Sensitif" badges; the owner (no
    `roles.manage`) sees it read-only.
16. A user without `staff.manage`/`roles.manage` gets 403 on `/roles-staff` and on a direct
    action call.

---

## 11. Session split (one feature per session)

| # | Session | Contents | Reviewers |
|---|---|---|---|
| S1 ✅ | Schema + admission + landing | Migration 0041 (columns, owner `staff.manage`, predefined roles, trigger), seed changes, admission expiry predicate, Google verified-email check, `firstAllowedHref` + `/` redirect; tests 1-3, 9, 10; nav-rbac e2e | database, security, typescript |
| S2 ✅ | Staff write path | `lib/staff/*`: invite, renew, update, role change, deactivate/reactivate, revoke sessions, subset rule, advisory lock, rate limits, audit rows, invite email; actions; tests 4-8 | security, database, typescript |
| S3 ✅ | Staff UI | Staf tab list (both layouts), invite sheet (with the WhatsApp reminder, answer 8), detail page; read queries; e2e 12-14, 16 | react, typescript |
| S4 ✅ | Roles UI | Peran tab, labels, read-only matrix, editor for `roles.manage`, create/copy role; test 7, 11, e2e 15. Product-list fix for `content.manage` (answer 5) | react, security, typescript |
| S5 | Onboarding (ops, no code) | Owner invites wife (owner role) and first staff on dev, then prod after release; SPEC/deploy docs updated | - |

S1 and S2 can ship before the UI (no user-visible change). S4 can slip without blocking the
wife's account, since S3 already lets the owner assign predefined roles.

---

## 11a. Review outcome (S1+S2, 2026-10-27)

database-reviewer, typescript-reviewer and security-reviewer ran on S1+S2. Fixed:

- **Hard super_admin rule** on top of the subset rule: only an actor whose own role is
  `super_admin` may assign `super_admin` or act on someone holding it, even if a future role edit
  gave another role every permission (`assertSuperAdminOnly`).
- **Pending invitations don't count as holders** in the last super_admin/owner checks (app and
  trigger): only rows that logged in before, or have no invite expiry (seed accounts), count. A
  typo'd super_admin invite can no longer make the real one removable.
- **Trigger** now also fires on `DELETE`, and refuses removing a super_admin outside READ
  COMMITTED (fail closed: the fresh-snapshot argument only holds there). A `FOR UPDATE` variant
  was tried and deadlocked two overlapping removals. The two-connection test now uses a barrier,
  not a sleep.
- The invite email is raced against a 15 s timeout, and the post-commit failure audit can't
  throw any more (an invite that exists never reports an error).
- `seed.ts` `insertRoleIfMissing` runs in one transaction and fails loudly on a permission key
  missing from the catalog.
- Name validation also refuses format (bidi), line and paragraph separator characters; zod
  messages for non-string input are Indonesian; email comparison in `updateStaffProfile` uses
  `normalizeStaffEmail`.
- Action tests assert the specific interrupt (`forbidden()` / `NEXT_REDIRECT`) and that no
  mutation was reached.

Follow-ups (not done, by design or for later sessions):

- **S4 must take `STAFF_ACCESS_LOCK_KEY` in every `role_permissions` write**, or the subset check
  can race a role edit; and forbid granting `roles.manage`/`audit_log.view` to non-super_admin
  roles.
- Rate-limit query scans the actor's audit rows (index on `actor_staff_user_id` only). Fine at
  this volume; add `(actor_staff_user_id, action, created_at)` in a later migration if it grows.
- A failed invite email still starts the 10-minute renew cooldown; an email correction on a
  pending invite doesn't resend (S3 UI should offer "Kirim ulang undangan" after either, and after
  reactivating someone whose invite expired).
- Invite emails have a per-actor cap only (20/h), no global cap; accepted for a 2-person admin.
- Rollback note for deploy docs (S5): running an OLDER image's `db:seed` re-syncs the owner role
  and removes `staff.manage` again. Don't run seed from an older image.
- `validationError` is duplicated from product-types actions (could move to `lib/action-result.ts`).

## 11b. Built details (S3+S4, 2026-10-27)

- Pages: `/roles-staff` (Staf tab with status chips, Peran tab via `?tab=peran`),
  `/roles-staff/staff/[id]`, `/roles-staff/roles/[id]`, `/roles-staff/roles/new` (`?copyFrom=`).
  Reads in `lib/staff/queries.ts`; what the staff page offers mirrors the guard rails in
  `lib/staff/capabilities.ts` (UI only, the mutations still decide).
- Role writes (`lib/staff/role-mutations.ts`): every one takes `STAFF_ACCESS_LOCK_KEY` first and
  requires an active actor whose role is `super_admin` AND holds `roles.manage` (answer 1). The
  editor saves name, description and permissions in ONE transaction (`updateRole`), refuses if
  the role's permissions changed since the page loaded, and never grants `roles.manage` /
  `audit_log.view`. Role names are unique case-insensitively (checked under the lock). New role
  keys are `custom_<random>`.
- Intentional: a super_admin may rename or change the permissions of the `owner` system role
  (only `super_admin` is fixed); a super_admin always remains to undo it.
- Invite cooldown (§11a follow-up): the 10-minute per-person cooldown is skipped right after a
  failed send or a corrected email, so "Kirim ulang undangan" works there; a hard cap of 3 invite
  emails per person per hour still applies (security review).
- `PermissionKey` is a plain `string` type (PERMISSIONS is annotated), so the label map is
  checked by `permission-labels.test.ts` at runtime, not by the compiler.
- `content.manage` opens `/products` and its nav item (answer 5); "Tambah produk" and every
  non-content step stay behind `products.manage`.

## 12. Owner decisions (2026-10-27)

All questions from the first draft are answered; none open.

1. Only super_admin creates custom roles and edits permissions; everyone else uses the predefined
   roles read-only.
2. **The owner role (the wife) gets `staff.manage` from the start** (differs from the first
   recommendation). Guard rails stay: she can't manage a super_admin, and can only assign/manage
   roles whose permissions she holds (subset rule, §5).
3. Invitations last 7 days, renewable from the staff page.
4. Packing uses `orders.manage` for launch (audited); `orders.ship` later if needed.
5. `content.manage` can open the product list and edit content fields only; photos stay under
   `products.manage` (S4).
6. Packing/Gudang doesn't see Ringkasan and lands on `/packing` after login (built in S1).
7. Roles can't be deleted in v1; rename instead.
8. Invite emails are sent; the UI also reminds the owner to message the person on WhatsApp (S3).
9. CS can't void vouchers or use Impor.
10. Only the owner (Tangguh) is super_admin; the wife is owner.
