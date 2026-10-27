# Plan: Pertumbuhan (Iklan & Biaya, Pelanggan & Voucher)

Status (2026-10-27): **Approved.** Owner answers recorded in §13 (A1 to A14 accepted as
recommended; A2, dropping the unused `expenses` / `ad_spend_daily` tables in a later cleanup
migration, confirmed by the owner on 2026-10-27).

Built: **S1** (migration `0042_growth`, schema, constants, permissions, pure figures and voucher
status with TDD, migration test) and **S2** (expense write paths, `expense_proof` private-file
plumbing, `/ads-expenses` Pengeluaran list + "Catat biaya" dialog + void, Log Aktivitas labels,
e2e at 390px and 1280px), both committed, and **S3** (expense figures: "Ringkasan" tab, Laba bersih
tile on `/`, "Biaya bulanan belum dicatat" item configurable on `/settings` with migration 0043,
e2e), **S4 + S5** (Pelanggan & Voucher, committed together in bf0180f) and **S6** (promo export,
self-serve promo opt-out on `/account`, "Unduh laporan bulanan" PDF + Excel, break-even ROAS from
the period's own margin; owner additions A and B of 2026-10-27). All sessions built.

S1/S2 notes (where the build differs from or adds to the text below):
- `business_expenses_channel_check` also refuses a missing channel on Iklan Shopee/TikTok (IS NOT
  DISTINCT FROM), so the CASE can never pass a NULL through; the app additionally limits optional
  channels to Shopee, TikTok Shop, Situs, Instagram, WhatsApp (`expenseChannelError`).
- Campaign is accepted only on marketing categories (app rule; the DB only checks length and
  non-blank). Note and campaign are non-blank and length-capped by CHECKs too.
- Migration 0042 reuses 0038's `prevent_voidable_record_mutation` for `business_expenses`; the CS
  grant of `customers.manage` is applied only while that role still holds `customers.view`
  (`migration-0042.test.ts` covers both cases), and `PREDEFINED_ROLES` lists it for fresh seeds.
- Duplicate-proof warning: `findProofHashUses` (lib/expenses/records.ts) searches expenses, plus
  supplier payments only when the viewer holds `supplier_payments.manage`.
- `/ads-expenses` has no tab bar yet: the "Ringkasan" tab arrives with S3. The list is per month
  (`?month=YYYY-MM`, default this Jakarta month, future months fall back), with "Semua / Iklan /
  Operasional" tabs, a category filter limited to the chosen group, search (No. biaya, kampanye,
  catatan) and "Tampilkan yang dibatalkan". The footer total always excludes voided rows.
- S3: the web shipping subsidy is `PeriodMoney.webShippingSubsidy` in `getPeriodTotals` (one
  more column of the counted-orders CTE, `orderWebShippingSubsidySql` in `revenue-sql.ts`), so it
  follows the counted-order definition exactly (a refunded or chargeback checkout order's subsidy
  is out with its omzet). DB reads in `lib/expenses/summary.ts` (`getExpenseBreakdown`,
  `getExpenseTotal`, `getMonthlyBillsReminder`, `dateRangeToTimeRange`); pure `buildRoasRows`,
  `shiftMonth`, `monthlyBillsReminderWindow`, `formatRoasTenths` in `figures.ts`; the summary period
  in `search-params.ts` (`?tab=ringkasan&period=this_month|last_month|month|range`, `month=` /
  `from=&to=` as `YYYY-MM`, invalid or > 12 months falls back to this month with an alert).
- S3 UI: `/ads-expenses` has a "Pengeluaran / Ringkasan" tab bar; the Ringkasan tab
  (`_components/expense-summary.tsx`) shows Omzet, Laba setelah biaya platform, Total biaya, Laba
  bersih (+ "Subsidi ongkir situs"), the "belum lengkap" notes plus "Laba bersih belum lengkap"
  when HPP or platform fees are incomplete, "Biaya per kategori" and "Iklan vs omzet" (both
  `CardList` + `TableContainer`), "Biaya endorse" and "Biaya pemasaran". ROAS of Situs, Instagram,
  WhatsApp and Total is labelled "(perkiraan)"; a channel without spend shows "Belum ada iklan".
- S3 Ringkasan (`/`): the "Laba bersih" tile (`kpi-laba-bersih`) has the same delta line as the
  other tiles (previous period = same stretch of last month, expenses by their dates); its link to
  `/ads-expenses?tab=ringkasan` needs `ads_expenses.manage`. The Perlu tindakan block "Biaya
  bulanan belum dicatat" needs `ads_expenses.manage` + `finance.view_profit`, is not rendered while
  no category is chosen on `/settings`, collapses to "Tidak ada" when nothing is missing, names the
  missing categories ("Sewa", "Gaji dan Sewa", "Gaji, Sewa, dan Utilitas") and links to the
  Pengeluaran list for the payment window (`/ads-expenses?from=YYYY-MM-06&to=YYYY-MM-05&group=operational`;
  the list accepts a `from`/`to` window of real dates, `from <= to <= today`, at most 366 days,
  which replaces the month filter).
- Pure functions live in `lib/expenses/figures.ts` (channel rules, `monthRange`, `monthToDate`,
  `sumExpensesInRange`, `labaBersih`, `summarizeMarketing`, `roasTenths`, `roasStatus`; ROAS is
  compared in integers: `omzet * 10 >= adSpend * 83`) and `lib/vouchers/status.ts`
  (`effectiveVoucherStatus`, 14-day "segera berakhir").

S4/S5 notes (customers and vouchers; written in S6, where the build differs from or adds to the text
below):
- List (`lib/customers/directory.ts` `listCustomers`): masking on the server (`mask.ts`:
  `nu***@gmail.com`, `+62 812 **** 4567`), so the list payload never carries a full contact.
  Filters `?filter=account|buyer|promo|voucher` ("Punya akun", "Pernah belanja", "Setuju promo",
  "Voucher aktif"), sorts `newest|spend|last_order`, `all=1` = "Termasuk yang belum pernah
  belanja" (A13). Search: name and email `ilike`, phone as a prefix of the normalised `+62...`
  number (`phoneSearchPrefix`, so `0812...` finds `+62812...`).
- Detail (`getCustomerDetail`): order rows carry only id, no., date, channel, status, payment
  status, total, counted (a test pins the key list so a contact snapshot can never slip in). "Ditarik
  pada" is the newest withdrawal audit row's date (only read while consent is NULL).
- Withdrawal (`lib/customers/consent.ts`): sources WhatsApp / Email / Lainnya (note required for
  Lainnya, ≤ 300; the dialog warns not to type a number or email). Row locked `FOR UPDATE` only so
  the audit keeps the exact cleared timestamp; the conditional UPDATE decides. Audit
  `customer` / `promo_consent_withdraw` with `{promoConsentAt}` before and `{source, note}` after.
  Re-opt-in at checkout is covered in `place-order.test.ts`.
- Vouchers: SQL twin of the effective status in `lib/vouchers/status-sql.ts`; overview and period
  stats in `lib/vouchers/overview.ts` ("Nilai voucher aktif" read only for finance.view_profit).
  Void/extend live in `@ammari/commerce/voucher-adjustments` (`packages/commerce/src/vouchers/adjustments.ts`),
  not in the admin app, so checkout's redemption and the adjustments sit next to each other: one
  conditional UPDATE each (row locked first only for the history snapshot), reason ≤ 500, extension
  to the end of a chosen Jakarta day, after today and after the current expiry, ≤ 3 months from today.
  Concurrency (void vs redeem, extend vs redeem) is tested there.
- Ringkasan voucher card (`overview-voucher-card.tsx`): counts only (Kartu dicetak, Kartu diklaim,
  Voucher dipakai) for the period on screen, `customers.view`, links to `/customers?tab=voucher`.
- e2e `customers.spec.ts`: owner, CS and a role without `customers.view`, each pass on its own
  seeded customer at 390px and 1280px.

S6 notes:
- **Promo export** (§10): `GET /customers/promo-export?ack=1` (`customers.view` + `customers.export`,
  400 without `ack=1`, so a bare link cannot skip the warning). Rows: `promo_consent_at IS NOT NULL`
  **and** a `customer_auth_users` row **and** an email (the account guard keeps "consent given while
  logged in" true even if another writer appears). CSV via `buildCsv` (formula-safe, BOM), columns
  Nama, Email, Nomor HP (digits only, `62812...`, the form WhatsApp tools import; no formula guard needed), Setuju promo sejak (WIB). Audit `customer_export` /
  `export_promo_contacts`, `{filter, rowCount}` only. UI: "Unduh kontak promo" on the Pelanggan &
  Voucher header (owner/super_admin), dialog with the four rules (own promo only, never Meta/TikTok
  or any ad platform, re-export before every send, delete after) and the required tick.
- **Self-serve promo on `/account`** (A11): section "Kabar promo" with "Berhenti terima promo" (one
  press, no dialog) and, when off, "Terima kabar promo" with the consent sentence above the button.
  `apps/web/src/lib/account/promo-consent.ts` `setPromoConsent`: row locked, one conditional UPDATE
  each way (withdraw only while set; opt in stamps `now()` only while unset, so an existing consent
  keeps its date). Audit (buyer, actor NULL) `customer` / `promo_consent_withdraw_self` and
  `promo_consent_grant_self`, `{promoConsentAt}` before/after plus `by: "customer"`; an opt-in
  also stores `consentText`, the exact sentence shown above the button (consent evidence). Per-IP limit
  `promo_consent_change` (30 per 10 min, as "Hapus alamat"). The admin detail's "Ditarik pada" now
  also reads the self-serve row and adds "oleh pelanggan sendiri di akunnya".
- **Titik impas ROAS** (owner addition B): the fixed 8.3 was 1 ÷ 12%, the "Ads 12%" planning share
  in `cost_assumptions` (SPEC §7): an ad budget target, not a break-even. Replaced by a figure
  computed per period (`breakEvenRoas` in `figures.ts`):
  `contribution = laba setelah biaya platform − subsidi ongkir situs`,
  `titik impas ROAS = omzet ÷ contribution` (= 1 ÷ contribution margin). Fixed costs (Gaji, Sewa,
  ...) stay out: they do not grow with an ad. Comparison is exact in BigInt
  (`omzet_ch × contribution ≥ omzet × adSpend`). Fallbacks: no omzet → "Belum bisa dihitung"
  (status `unknown`, no colour); contribution ≤ 0 → "Tidak ada" (every row with spend is below).
  HPP/fees incomplete → shown with "titik impas sebenarnya lebih tinggi". Chosen over a `/settings`
  value: it needs no migration, moves with real margins (Shopee fees, discounts), and cannot go stale.
  One figure per period for every row (per-channel margins are a possible follow-up; TikTok fee rows
  are often still missing, which would make a per-channel figure misleading today).
- **Unduh laporan bulanan** (owner addition A): `GET /ads-expenses/report?format=pdf|xlsx&period=...`
  (`ads_expenses.manage` + `finance.view_profit`; same params and parser as the Ringkasan tab; the
  links send the shown months explicitly). Both files are built from `getExpenseSummary`
  (`summary.ts`), the one call the tab itself now makes, so the numbers are identical.
  `report.ts` adds the non-voided expense rows and `listCountedOrders` (`overview/queries.ts`, same
  counted-orders CTE as `getPeriodTotals`; capped at 50.000 rows with a note). PDF: pdf-lib (already
  a dependency) with built-in Helvetica, A4, brand mark from `apps/admin/public/logos/ammari-mark-512.png`
  (copied from apps/web; drawn without it if unreadable), P&L, per-channel table, notes, footer
  "Laporan manajemen, bukan laporan keuangan resmi." + generated-at. **No new dependency** and no
  headless browser. Excel: vendored SheetJS, sheets Ringkasan, Per kanal, Biaya, Pesanan; typed cells
  (text never a formula) plus `neutralizeFormula` on text. Audit `expense_report` / `download`
  ("Laporan keuangan bulanan diunduh"), `{format, fromMonth, toMonth, expenseRows, orderRows,
  ordersTruncated}`, written only after the file was built.
- Contract-migration note (A2): `expenses` and `ad_spend_daily` are still unused (no reader or
  writer in `apps/*/src` or `packages/*/src`). Drop them in a later migration once dev and prod show
  0 rows (`select count(*) from expenses; select count(*) from ad_spend_daily;`), together with the
  old `EXPENSE_CATEGORIES` constant and SPEC §5.2's two bullets. Not part of S6.

Two admin pages under the "Pertumbuhan" nav group, both `ComingSoonPage` today:

- **A. Iklan & Biaya** (`/ads-expenses`): record every ad and operating expense with a required
  proof, append-only, and show "Laba bersih" and ad spend vs omzet (ROAS).
- **B. Pelanggan & Voucher** (`/customers`): customer list and detail, voucher overview, voucher
  void/extend, promo-consent handling.

Admin only; `apps/web` is untouched. SPEC §3.2 lists both for "first week of
November 2026".

---

## 1. What exists today (verified against the code)

**Unused expense tables.** Migration 0000 created two tables that no code reads or writes
(`grep` over `apps/*/src`, `packages/*/src`, seed and seed-dev finds only the schema):

- `expenses` (`schema/orders.ts:447`): `date`, `category` CHECK in `EXPENSE_CATEGORIES`
  (`packaging, shipping, tools, salary, operational, other`), `amount >= 0`, `description`,
  `created_by_staff_user_id`, `created_at/updated_at` + `set_updated_at` trigger. Mutable, no
  proof, no void, categories that do not match the brief.
- `ad_spend_daily`: `(date, channel_id)` unique, `amount`, `attributed_revenue_amount`. One row per
  day per channel: a typed-in daily figure with no proof, the opposite of what we want.

**Permissions already in the catalog and in every database** (migration 0014, roles in 0041):

| Key | super_admin | owner | finance (Keuangan) | customer_service (CS) | Others |
|---|---|---|---|---|---|
| `ads_expenses.manage` "Record ad spend and expenses" | yes | yes | **yes** | no | no |
| `finance.view_profit` | yes | yes | yes | no | no |
| `customers.view` | yes | yes | no | **yes** | no |
| `vouchers.void` (unused by any action) | yes | yes | no | **no** (roles-staff answer 9) | no |

Nav (`lib/nav/config.ts`): Iklan & Biaya needs `ads_expenses.manage`, Pelanggan & Voucher needs
`customers.view`; nav filter is any-of (`filter.ts:12`), cosmetic only.

**Private proof stack** (docs/plans/purchase-payments.md, S1 to S5 built):

- `private_files` (immutable, trigger `prevent_private_file_mutation`), `purpose` CHECK in
  `PRIVATE_FILE_PURPOSES = [payment_proof, purchase_invoice]`; each referencing table pins its
  purpose with a composite FK `(file_id, purpose)`.
- `lib/supplier-payments/proof-processing.ts` (`processPrivateUpload`: magic-byte sniff, HEIC
  refused with a clear message, JPEG re-encode ≤ 2000 px / ≤ 600 KB ladder, EXIF stripped, PDF
  passthrough with script/launch/embedded-file refusal, 10 MB cap), `store-upload.ts`
  (`storePrivateUpload`: object first, row later inside the transaction), `private-files.ts`
  (`buildPrivateFileKey`, `findServablePrivateFile`, `PRIVATE_FILE_VIEW_PERMISSIONS`),
  `payment-records.ts` (`assertPaidAt`, `normalizeNote`, `normalizeReason`,
  `privateFileValues`, `findPaymentsWithProofHash`), `form-input.ts`.
- `GET /api/private-files/[fileId]`: session, `finance.view_profit` first, then the purpose's keys,
  only files referenced by a row, checksum verified, `no-store`, CSP per type.
- UI: `components/supplier-payments/private-file-field.tsx`, `private-file-link.tsx`,
  `void-record-button.tsx` (takes its server action as a prop), `payment-history.tsx`.
- Nightly backup copies the private bucket (prefix-agnostic; verify in S2 that `expense_proof/`
  is picked up without a change).

**Profit on Ringkasan** (`lib/overview/queries.ts`, SPEC §6): `PeriodMoney` already has omzet,
laba kotor, platform fee and `labaSetelahBiayaPlatform`, with "Biaya platform belum lengkap untuk N
pesanan". SPEC says the web shipping subsidy and ad spend "stay out" of that figure. Break-even
ROAS is **8.3** (SPEC §6). Periods: today, yesterday, 7d, month, custom (max 366 days).

**Customers** (`schema/customers.ts`): `phone` (nullable unique, +62 format), `email` (citext,
nullable unique), `name`, `type` (`retail`/`reseller`), `phone_verified_at`,
`email_verified_at`, `pdp_consent_at`, `promo_consent_at`, `contact_offer_resolved_at`,
timestamps. Three ways a row is born:

1. Main-site sign-up or voucher claim (Better Auth, `customer_auth_users.customer_id`), PDP
   consent through the `/consent` gate.
2. Guest checkout `linkOrCreateGuestCustomer` (`place-order.ts:463`): email + name only, **email
   unverified**, no consent stamped on the customer (the order keeps `promo_opt_in`).
3. Staff manual order (`/orders/new`): name + optional phone, no consent.

Marketplace imports store no buyer data (`customer_id` null). `promo_consent_at` is set only for
a logged-in buyer (session checkout or the `/account` contact offer). **There is no self-serve
"withdraw promo consent" control on `/account`**, yet the published policy promises withdrawal "kapan
saja" by email/WhatsApp request.

**Vouchers.** `thank_you_cards` (status `active/claimed/void`, `claim_deadline`, claimer),
`vouchers` (one per card, `amount` default 20000, status `active/used/expired/void`,
`issued_at`, `expires_at`, `used_order_id`, `used_at`). Important: **`expired` is only written by
`restoreVoucherForCancelledOrder`**; an ordinary voucher that ran out still has status `active`
with `expires_at <= now()`. Checkout redeems with one conditional UPDATE
(`status = 'active' and expires_at > now()`). Nothing ever writes `void`.

**Privacy policy** (published 23 Oct, `docs/launch/legal-drafts.md`): data minimisation; staff
access "dibatasi untuk staf yang membutuhkannya"; promo only with separate consent, withdrawable
any time; data shared only with payment, shipping, email, infrastructure providers and
authorities; **"Ammari tidak menjual data pribadimu"**; unpaid expired/cancelled orders' contact
and address anonymised after 90 days (job not built; first checkout orders reach 90 days on
1 Mar 2027; `retention.ts` notes it as a later session).

**Audit and Log Aktivitas.** `writeAuditLog(tx, {actorStaffUserId, action, entityType, entityId,
before, after})`; `lib/activity-log/catalog.ts` must list every `(entity_type, action)` pair
(`catalog.test.ts` scans the source); areas include `payments` and `cards` ("Kartu & Pembeli");
`fields.ts` has field labels and secret redaction.

Next migration number: **0042**.

---

## 2. Decisions ([owner] = confirmed by the owner, 2026-10-27)

| # | Decision |
|---|---|
| G1 | New append-only table **`business_expenses`**; the unused `expenses` and `ad_spend_daily` are left untouched now and dropped later in a separate contract migration ([owner A2], confirmed 2026-10-27). Reusing `expenses` would mean dropping its `updated_at` trigger and columns and replacing its CHECK in the same deploy, for no benefit. |
| G2 | [owner A1] Categories are a **fixed list in code** behind a CHECK, Indonesian labels in `apps/admin`. "Lainnya" requires a note. |
| G3 | Same rules as supplier payments: proof **required**, no edit, no delete, void with required reason, voided rows stay visible struck through and stop counting. DB trigger enforces it. |
| G4 | Proofs reuse the private bucket and route with a new purpose `expense_proof`. |
| G5 | [owner A3, A4] **Laba bersih** = Laba setelah biaya platform − web shipping subsidy − non-voided expenses **by expense date** (cash basis). Shown for whole calendar months only (§4.2). |
| G6 | ROAS = omzet ÷ ad spend, per channel where the ad is tied to one channel, plus a total. Colour vs break-even 8.3. |
| G7 | **No new permission for expenses**: reuse `ads_expenses.manage` (+ `finance.view_profit`). Keuangan, owner, super_admin already have both. |
| G8 | [owner A10] Customer pages read-only for identity. Only consent withdrawal can be recorded by staff (§8.3). |
| G9 | [owner A8] Voucher void and extend: owner/super_admin only, reason required, audited, atomic conditional UPDATE, history in a new append-only `voucher_adjustments` table (§9). |
| G10 | [owner A9] Promo contact export: lawful only for Ammari's own promo messages to customers with `promo_consent_at`; never uploaded to ad platforms. New key `customers.export`, owner/super_admin only, audited (§10). |

---

## A. Iklan & Biaya

## 3. Schema (migration 0042, additive)

### 3.1 Constants (`schema/constants.ts`)

```ts
export const BUSINESS_EXPENSE_CATEGORIES = [
  "ads_meta", "ads_tiktok", "ads_shopee", "endorsement",        // Iklan Meta, Iklan TikTok, Iklan Shopee, Endorse/KOL
  "material_shipping", "packaging", "salary", "rent", "utilities", "other",
] as const;                                                    // Ongkir bahan, Packaging, Gaji, Sewa, Utilitas, Lainnya
export const AD_EXPENSE_CATEGORIES = ["ads_meta", "ads_tiktok", "ads_shopee"] as const;   // "Biaya iklan"
export const MARKETING_EXPENSE_CATEGORIES = [...AD_EXPENSE_CATEGORIES, "endorsement"] as const;
export const BUSINESS_EXPENSE_METHODS = ["cash", "transfer", "card", "platform_balance"] as const;
// Tunai, Transfer, Kartu (debit/kredit, e.g. Meta billing), Saldo platform (Saldo Penjual Shopee/TikTok)
```

`PRIVATE_FILE_PURPOSES` gains `"expense_proof"`. The old `EXPENSE_CATEGORIES` stays (it backs the
old table's CHECK) until the contract migration.

### 3.2 `business_expenses`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| expense_no | text unique | `BYA-YYYYMM-NNN` via `nextDocumentNumber(tx, "BYA", ...)` |
| expense_date | date | Jakarta day the money left; app: not in the future, no lower bound (as A9) |
| category | text | CHECK in `BUSINESS_EXPENSE_CATEGORIES` |
| amount | bigint | CHECK > 0, whole rupiah |
| method | text | CHECK in `BUSINESS_EXPENSE_METHODS` |
| channel_id | text FK channels RESTRICT, nullable | the sales channel an ad/endorse is for. CHECK: `ads_shopee` ⇒ `shopee`, `ads_tiktok` ⇒ `tiktok`; non-marketing categories ⇒ NULL |
| campaign | text nullable | free text ≤ 120 ("Ramadan 2027", "KOL @nama") |
| note | text nullable | ≤ 500; CHECK `category <> 'other' or btrim(note) <> ''` |
| proof_file_id | uuid not null unique | composite FK `(proof_file_id, proof_file_purpose)` → `private_files(id, purpose)` |
| proof_file_purpose | text default `expense_proof` | CHECK `= 'expense_proof'` |
| recorded_by_staff_user_id | uuid not null FK staff_users RESTRICT | |
| created_at | timestamptz | = recorded at |
| voided_at / voided_by_staff_user_id / void_reason | | `num_nonnulls in (0,3)`, reason non-blank |

Indexes: `(expense_date, created_at)` (ascending, backward-scanned for the list's DESC order), `(category, expense_date)`, `channel_id`, both staff FKs.

Trigger `prevent_business_expense_mutation`: same body as `prevent_supplier_payment_mutation`
(DELETE always refused; UPDATE refused if already voided or if anything except the three void
columns changes).

### 3.3 `private_files` CHECK widen

Drop and re-add `private_files_purpose_check` with the three purposes, in the same migration. A
widen only: every existing row still passes; the previous release never writes `expense_proof`.

### 3.4 Backward compatibility

New tables, new triggers on new tables, one CHECK widen, new reference rows (§7, §10). Nothing the
current release reads or writes changes. Rollback is safe: an older image ignores the new tables;
the only effect is that `/api/private-files` in the older image 404s an expense proof (its
`findServablePrivateFile` doesn't join `business_expenses`). Acceptable for a rollback window.

## 4. Figures ("Ringkasan" tab), finance only

### 4.1 Definitions (pure functions + SQL, TDD)

```
expenses(range)          = Σ amount  where voided_at is null and expense_date in range (Jakarta dates)
adSpend(range, channel)  = Σ amount  where category in AD_EXPENSE_CATEGORIES and channel_id = channel
marketing(range)         = adSpend(all) + endorsement
labaBersih(range)        = labaSetelahBiayaPlatform(range)        (existing getPeriodTotals)
                         - webShippingSubsidy(range)              (A4: Σ orders.shipping_subsidy_amount of counted web checkout orders)
                         - expenses(range)
roas(channel)            = omzet(channel) / adSpend(channel)      (null when adSpend = 0)
roasTotal                = omzet(all) / adSpend(all)              (includes Meta without a channel)
```

Omzet and the counted-order set come from the existing `revenue-sql.ts` helpers, never a second
definition. The incompleteness notes carry over ("HPP belum lengkap", "Biaya platform belum
lengkap untuk N pesanan") so Laba bersih is never shown as clean when its inputs are not.

ROAS per channel only where it means something:

- **Shopee** and **TikTok Shop**: ads are tied to the channel by category, so ROAS is real.
- **Meta** ads tagged with a channel (`web`, `instagram`, `whatsapp`) count for that channel;
  untagged Meta spend shows on a "Tanpa kanal" row and only enters the total. Labelled "perkiraan"
  because Meta drives buyers to several channels.
- Endorse/KOL is shown as its own line ("Biaya endorse") and is **not** in ROAS (no channel
  attribution). Total "Biaya pemasaran" = iklan + endorse.
- Colour: ROAS ≥ 8.3 olive ("Di atas titik impas"), below brick ("Di bawah titik impas"),
  no colour when spend is 0.

### 4.2 Allocation of monthly bills (owner answer A3)

**By expense date (cash basis), shown per whole calendar month.**

- Each expense counts once, in full, on the Jakarta day it was paid (the date on its proof). No
  proration, no accruals: what the wife enters is exactly what the books show.
- The Iklan & Biaya Ringkasan period picker offers **months only**: "Bulan ini (s.d. hari ini)",
  "Bulan lalu", a month picker, and "Rentang bulan" (max 12). A 7-day or one-day Laba bersih
  would swing wildly on the day Gaji or Sewa is paid, so it is not offered.
- On the main Ringkasan, a **"Laba bersih"** tile appears only when the period is "Bulan ini"
  (`month`); for today/yesterday/7d/custom it is hidden (not shown as 0).
- Under the figure, one line: "Biaya dihitung pada tanggal dibayar. Gaji dan sewa yang dibayar di
  awal bulan masuk ke bulan itu."
- Known trade-off: Sewa paid yearly lands in one month. Acceptable for now; if it bothers the
  owner later, add an optional "untuk bulan" field (accrual-lite) in a follow-up, which is an
  additive nullable column.

### 4.3 Double-counting guards (UI hints, not code rules)

- **Ongkir bahan**: only shipping **not already on a purchase document**. Purchases include ongkir
  in their line totals (suppliers-goods-receipt D6), which flows into HPP. Field hint on the
  category.
- **Affiliate commission** (Shopee AMS, TikTok affiliate) already comes in through the import as
  `affiliate_commission` platform fees; do not also record it as Endorse/KOL. Hint on Endorse/KOL.
- **Web courier cost**: not an expense category. The subsidy is computed from orders (A4); the
  buyer-paid part is pass-through.
- **Supplier and tailor payments** stay in Pembelian/Produksi (they become HPP), never here.

## 5. Write paths (`apps/admin/src/lib/expenses/`)

**recordBusinessExpense(input, file, actor)**

1. zod: amount integer > 0 (max 1.000.000.000), `expense_date` ≤ today Jakarta, category,
   method, channel rules (§3.2), campaign ≤ 120, note ≤ 500 (required for Lainnya).
2. `processPrivateUpload` + `storePrivateUpload(processed, "expense_proof")` (object before the
   transaction, as purchase-payments §5.7).
3. Transaction: `nextDocumentNumber` advisory lock, insert `private_files`, insert
   `business_expenses`, `writeAuditLog` action `record`, entityType `business_expense`, after =
   full row. No balance cap, so no parent lock needed; concurrency safety is the unique
   `expense_no` and `proof_file_id`.
4. Non-blocking duplicate warning: same `original_sha256` already used by a non-voided expense
   **or** supplier payment ("Bukti ini sudah dipakai untuk BYA-... / BYR-..."). Generalise
   `findPaymentsWithProofHash` to search both tables.

**voidBusinessExpense(id, reason, actor)**: `UPDATE ... SET voided_* WHERE id = $1 AND voided_at
IS NULL RETURNING *`; zero rows means "Biaya ini sudah dibatalkan." Audit `void` with before/after.

Reused as-is from `lib/supplier-payments/`: proof processing, upload, form helpers, void button,
file field, file link. No file moves in this feature (a later tidy-up can move the shared parts to
`lib/private-files/`).

`private-files.ts`: `PRIVATE_FILE_VIEW_PERMISSIONS.expense_proof = ["ads_expenses.manage",
"finance.view_profit"]`; `findServablePrivateFile` left-joins `business_expenses` and names the
download `<expense_no>.jpg|pdf`.

## 6. UI (`/ads-expenses`, Indonesian, phone first, no em dash)

Page guard: `ads_expenses.manage` **and** `finance.view_profit` (every expense is a cost figure).
Two tabs (`Tabs`, `?tab=`):

**"Pengeluaran"** (default)

- Header button "Catat biaya" opens a dialog: Tanggal bayar (default hari ini), Kategori (Select,
  grouped "Iklan" / "Operasional"), Jumlah (Rp), Metode, Kanal (shown only for iklan/endorse;
  fixed and disabled for Iklan Shopee/TikTok), Kampanye (opsional), Catatan (wajib untuk
  Lainnya), Bukti (wajib). Errors reuse the proof messages ("Bukti wajib diunggah.", "Foto HEIC
  belum didukung. Ubah ke JPG lalu unggah ulang.", ...).
- List: `CardList` (phone) + `TableContainer` (≥ md): No., Tanggal, Kategori, Kanal/Kampanye,
  Jumlah, Metode, Dicatat oleh, Bukti, and "Batalkan" per row (dialog with "Alasan pembatalan").
  Voided rows struck through with a "Dibatalkan" badge and reason.
- Filters: month (default this month), `FilterTabs paramName="group"`: Semua, Iklan, Operasional;
  Kategori select; "Tampilkan yang dibatalkan" toggle. Footer total for the filter (non-voided).
- `Pagination` + `PerPageSelect`, as other lists.

**"Ringkasan"**

- Month picker (§4.2).
- Tiles: Omzet, Laba setelah biaya platform, Total biaya, **Laba bersih** (olive if ≥ 0, brick if
  < 0), with the incompleteness notes.
- "Biaya per kategori": table (category, amount, % of omzet), sorted by amount.
- "Iklan vs omzet": per channel row (Shopee, TikTok Shop, Situs, Instagram, WhatsApp, Tanpa kanal,
  Total): Biaya iklan, Omzet, ROAS, badge vs 8.3. Plus "Biaya endorse" line.
- No chart in v1 (a 12-month bar of Laba bersih can come later).

**Main Ringkasan (`/`)**: "Laba bersih" tile next to "Laba setelah biaya platform", only with
`finance.view_profit` and period `month`; links to `/ads-expenses?tab=ringkasan`.

**Perlu tindakan** (finance only, owner answer A6, window and configuration decided by the owner on
2026-10-27): one item "Biaya bulanan belum dicatat" for LAST month, from the 6th of the current
month, for the categories chosen on `/settings` ("Pengingat biaya bulanan": checkboxes Gaji, Sewa,
Utilitas; the list can grow to any fixed category). **Default: none chosen = reminder off** (Ammari
has no rent and no staff yet; both are planned). Each chosen category needs its own non-voided
expense dated (Jakarta) from the 6th of last month through the 5th of the current month; the item
names the missing ones. Example on 6 Mar: window 6 Feb to 5 Mar (a Gaji paid 28 Feb or 3 Mar
counts for February; one paid 3 Feb is January's). The link opens the Pengeluaran list for that
window. With none chosen the block is not rendered at all.

Storage: `sales_goal.monthly_bill_categories text[] not null default '{}'` (migration **0043**,
additive: CHECK subset of `BUSINESS_EXPENSE_CATEGORIES`, no duplicates). The one-row `sales_goal`
already is the Ringkasan settings row on `/settings` under the same gate; `store_settings` is the
public storefront's (read by `apps/web`, `content.manage`), so it does not fit. The section and its
action need `settings.manage` + `finance.view_profit` (as Target penjualan); the save is audited as
`monthly_bills_reminder` / `update` ("Pengingat biaya bulanan diubah").

## 7. Permissions (A)

| Action | Requires |
|---|---|
| Open `/ads-expenses`, record, void, view proof | `ads_expenses.manage` + `finance.view_profit` |
| See Laba bersih tile on Ringkasan | `overview.view` + `finance.view_profit` |

No new key, no migration grant: the predefined **Keuangan** role already has both keys, owner and
super_admin have everything, CS/Packing/Konten have neither. Nav entry: keep `ads_expenses.manage`
(any-of is fine, the page enforces both). Update the description of `ads_expenses.manage` in
`permission-labels.ts` to "Catat dan batalkan biaya iklan dan operasional, lihat buktinya".

Audit catalog: new area `expenses: "Iklan & Biaya"`; entity `business_expense` with
`record: "Biaya dicatat"`, `void: "Biaya dibatalkan"`; field labels (`expense_no`, `expense_date`,
`category`, `method`, `channel_id`, `campaign`); Log Aktivitas search by `expense_no` and campaign.

---

## B. Pelanggan & Voucher

## 8. Customers

### 8.1 Who sees what

| Data | Requires |
|---|---|
| List + detail: name, email, phone, type, consent dates, orders count, last order, total belanja | `customers.view` (owner, super_admin, CS) |
| Order rows on the detail (link to `/orders/[id]`) | `customers.view`; the order page itself still needs `orders.view` |
| Voucher list, claim history | `customers.view` |
| Void / extend a voucher | `vouchers.void` (owner, super_admin) (A8) |
| Record promo-consent withdrawal | `customers.view` is not enough: new key `customers.manage` (A7) |
| Promo export | new key `customers.export` (A9) |

Total belanja is a selling figure (order totals are already visible with `orders.view`), so it is
not gated by `finance.view_profit`. No cost or profit appears on these pages.

Data minimisation in the UI (owner answer A5):

- **List masks contact data**: `nu***@gmail.com`, `+62 812 **** 4567`. Search still matches the
  full value server-side (exact or prefix on phone digits, `ilike` on name/email).
- **Detail shows full email and phone** (CS needs them to reply on WhatsApp).
- The detail **never shows order contact snapshots or addresses** (`contact_email`,
  `contact_phone`, `shipping_address`, saved addresses): those live on the order page and are the
  data the 90-day anonymisation will blank. Showing them here would create a second copy of
  exactly what the policy says disappears.
- Viewing is not audited (same reasoning as A10); the export is.

### 8.2 List (`/customers`, tab "Pelanggan")

Columns (`CardList` + `TableContainer`): Nama, Kontak (masked), Asal (Akun situs / Checkout tamu /
Dibuat staf), Persetujuan (PDP and Promo badges), Dibuat, Pesanan terakhir, Jumlah pesanan, Total
belanja.

- "Asal": account = a `customer_auth_users` row exists; guest = no auth row and has a checkout
  order; staff = neither.
- Orders, last order and total use the **counted-order** definition (`countedOrderSql`,
  `orderOmzetSql`): one aggregate subquery grouped by `customer_id`. Small table; no new index
  needed (`orders_customer_id_idx` exists).
- Search: name, email, phone (normalise `08...` to `+628...` first).
- `FilterTabs`: Semua, Punya akun, Pernah belanja, Setuju promo, Voucher aktif.
- Sort: Terbaru (default), Belanja terbesar, Pesanan terakhir.
- Default hides customers with zero counted orders **and** no account (a guest checkout that was
  never paid, or an abandoned staff entry); they appear under Semua with a toggle "Termasuk yang
  belum pernah belanja". Minimises what CS scrolls through without deleting anything.

### 8.3 Detail (`/customers/[id]`)

Sections, top to bottom (phone first):

1. **Profil**: name, email (+ "terverifikasi" badge), phone (+ badge), type, account yes/no and
   sign-in methods (Google / kode email, from `customer_auth_accounts.provider_id`), created.
2. **Persetujuan**: PDP consent date or "Belum", promo consent date or "Belum / Ditarik pada ...".
   Button "Catat penarikan persetujuan promo" (`customers.manage`) when promo consent is set.
3. **Pesanan**: counted and non-counted orders, newest first: No. pesanan, tanggal, kanal, status,
   total. Links to the order.
4. **Voucher**: each voucher with **effective status** (§9.1), amount, issued, expires, used on
   order (link), and its adjustment history; actions per row (§9.3).
5. **Kartu terima kasih diklaim**: card from order no, claimed at, claim deadline, card status.

**No identity editing** (owner answer A10). Why:

- Email is the login identity: Better Auth links `customer_auth_users` to `customers` by verified
  email, and guest checkout links by email. A staff edit could hand someone else's orders and
  vouchers to a different inbox.
- Phone is unique and used for matching at checkout and in manual orders.
- Customers already edit their own name and phone on `/account` (the policy's "memperbaiki data"
  right is self-serve there; anything else arrives as a request).
- The one staff write that is needed now is **recording a promo withdrawal**, because the policy
  promises withdrawal on request and there is no self-serve toggle yet.

**Withdraw promo consent** (`customers.manage`): dialog "Pelanggan minta berhenti menerima promo"
with a required "Sumber permintaan" (WhatsApp, Email, Lainnya + catatan). One statement:
`UPDATE customers SET promo_consent_at = NULL WHERE id = $1 AND promo_consent_at IS NOT NULL
RETURNING ...`, plus audit `customer` / `promo_consent_withdraw` with before (the old timestamp)
and the source. Zero rows: "Persetujuan promo sudah tidak aktif." The customer can opt in again at
checkout (place-order stamps only when null), which is correct. A self-serve toggle on `/account`
belongs to a main-site task (A11).

## 9. Vouchers (tab "Voucher")

### 9.1 Effective status (pure function, TDD)

```
used                                        -> "Terpakai"
void                                        -> "Dibatalkan"
expired, or active with expires_at <= now   -> "Kedaluwarsa"
active with expires_at > now                -> "Aktif" (+ "Segera berakhir" when ≤ 14 days, Jakarta)
```

Every query uses the SQL twin of this function; the stored `status = 'active'` alone is never
trusted as "usable", same as checkout.

### 9.2 Overview

- Tiles: Aktif (count, and with `finance.view_profit` the total value "Nilai voucher aktif",
  which is a liability), Terpakai, Kedaluwarsa, Dibatalkan.
- **Period block** (Ringkasan period vocabulary: this month default, last month, custom):
  Kartu dicetak (distinct orders with a card minted in the period), Diklaim (cards claimed in the
  period), **Tingkat klaim** = claimed ÷ printed for cards **whose claim deadline has passed** (a
  card still claimable is not yet a "no"), **Tingkat pemakaian** = used ÷ issued for vouchers
  issued in the period that are used or expired (same reasoning).
- **"Segera berakhir"** list: active vouchers expiring in the next 14 days: customer (link),
  amount, expires. Read-only; no message is sent from the admin (A12).
- **All vouchers** list with `FilterTabs` by effective status, search by customer name/email.

Ringkasan (`/`) hook: the SPEC's "Vouchers printed / claimed / redeemed counts" become a small
card on Ringkasan for `customers.view`, linking here (A6).

### 9.3 Void and extend (owner answer A8)

Both need `vouchers.void` (owner, super_admin; **not CS**, roles-staff answer 9) and a required
reason (≤ 500). Its description becomes "Batalkan atau perpanjang voucher" (UI label and the
`permissions.description` row, updated by the migration).

- **Void**: only an effective-active voucher. One statement:
  `UPDATE vouchers SET status = 'void' WHERE id = $1 AND status = 'active' AND expires_at > now()
  RETURNING ...`. Races safely with checkout's redemption (whichever commits first wins; the
  other gets zero rows: "Voucher sudah dipakai atau tidak aktif lagi."). An expired voucher needs
  no void. A used voucher cannot be voided (the money is spent; cancel the order instead).
- **Extend**: a voucher that is effective-active or expired, never used or void. New expiry =
  end of a chosen Jakarta day, after both the current expiry and now (the "after now" half is app-only: a CHECK cannot use now(),
  so `voucher_adjustments_new_expires_at_check` only enforces "after the old expiry"; S5 must test it), at most 3 months from today.
  `UPDATE vouchers SET expires_at = $new, status = 'active' WHERE id = $1 AND status IN ('active',
  'expired') AND used_order_id IS NULL AND expires_at < $new RETURNING ...`.
- A voided voucher stays void. If its card's order is later cancelled, nothing happens:
  `restoreVoucherForCancelledOrder` touches only `used` vouchers.

New append-only table **`voucher_adjustments`** (migration 0042), so the history is visible on the
customer page to CS without `audit_log.view`:

| column | notes |
|---|---|
| id, voucher_id FK RESTRICT (indexed) | |
| kind | CHECK in (`void`, `extend`) |
| previous_status, previous_expires_at, new_expires_at | `new_expires_at` required for extend, null for void (CHECK) |
| reason | non-blank |
| staff_user_id FK RESTRICT, created_at | |

Trigger rejects UPDATE and DELETE. The adjustment row, the voucher UPDATE and `writeAuditLog`
(`voucher` / `void` | `extend`) share one transaction; the adjustment is inserted only after the
conditional UPDATE returned a row.

Backward compatibility: `vouchers` itself gains no column; the previous release never writes
`void` and handles a void voucher like any non-active one (checkout refuses it, `/account` shows
its status).

## 10. Marketing consent export (owner answer A9)

**Lawful, narrowly.** The policy allows "Mengirim promo, hanya jika kamu memberi persetujuan promo
secara terpisah" and lists the only recipients of data. So:

- **Who**: only `customers.promo_consent_at IS NOT NULL` (always captured while logged in, so the
  email is verified). Never guest orders' `promo_opt_in` (unverified email, possibly someone
  else's), never staff-created customers.
- **What**: name, email, phone (if any), promo consent date. Nothing else (no orders, no spend).
- **Use**: Ammari's own WhatsApp/email promo. **Not** uploading to Meta/TikTok custom audiences or
  any tool not covered by the policy: that is sharing with a party the policy does not name.
  The export dialog states this and asks to tick "Saya paham data ini hanya untuk promo Ammari
  sendiri dan tidak diunggah ke platform iklan."
- **How**: CSV download from a route handler, `Cache-Control: no-store`, filename with the date.
  New key `customers.export` (migration 0042, granted to super_admin and owner only; CS and
  Keuangan never). Audit `customer_export` / `export_promo_contacts` with the row count and filter,
  **never the rows**.
- **Withdrawals**: since an exported file goes stale, the dialog says "Ekspor ulang sebelum setiap
  kirim promo"; the export always reflects current consent.

Approved (A9). Nothing else depends on it.

## 11. Migration 0042 summary (one migration, additive)

1. `business_expenses` + trigger; `voucher_adjustments` + trigger.
2. `private_files_purpose_check` widened with `expense_proof`.
3. Permissions (idempotent `ON CONFLICT DO NOTHING`), also added to `permissions.ts`:
   - `customers.export` → super_admin, owner.
   - `customers.manage` → super_admin, owner, and the `customer_service` role **if it exists and
     still holds `customers.view`** (respects a super_admin's edits to that role). Added to
     `PREDEFINED_ROLES` for fresh databases; `migration-0041.test.ts` compares 0041 alone, so a
     new 0042 test covers the CS grant.
   - `UPDATE permissions SET description = ...` for `vouchers.void` and `ads_expenses.manage`
     (descriptions only, no grant change).
4. No change to `expenses`, `ad_spend_daily`, `vouchers`, `customers`.

Run `drizzle-kit generate`, read the SQL, hand-add triggers and reference data (as 0038/0041).

## 12. Tests and sessions

### 12.1 Tests

TDD (vitest, `ammari_test`):

- Migration 0042: tables, CHECKs (amount > 0, channel rules, Lainnya needs note, proof purpose,
  void triple, adjustment kind/expiry pairing), triggers refuse DELETE and non-void UPDATE on
  expenses, second void refused, adjustments immutable, `private_files` accepts `expense_proof`,
  permissions and grants (CS grant only when the role still has `customers.view`).
- `recordBusinessExpense`: happy path writes file + expense + audit; future date, zero amount,
  missing proof, Lainnya without note, wrong channel for Iklan Shopee all refused; duplicate-proof
  warning finds a supplier payment's proof too.
- `voidBusinessExpense`: stops counting; double void refused; concurrent double void, exactly one
  wins.
- Figures: expense allocation by Jakarta date at month edges (paid 31st 23:30 WIB counts in that
  month); voided excluded; Laba bersih = existing laba setelah biaya platform − subsidy − expenses
  on a fixture; ROAS per channel, Meta untagged only in total, endorse excluded, zero spend → null;
  incompleteness notes propagate.
- Private-files route: expense proof 403 without `ads_expenses.manage`, 200 with both keys,
  download name `BYA-...`.
- Voucher effective status, all branches incl. stored `active` past expiry and stored `expired`.
- Void: active → void; used/expired refused; **concurrent void vs checkout redemption**, exactly
  one wins; adjustment + audit written only on success.
- Extend: expired → active with new date; new date not after current refused; > 3 months refused;
  used/void refused; concurrent extend + redeem consistent.
- Claim and redemption rates exclude still-open cards/vouchers.
- Promo withdrawal: clears consent, audit has source; second call reports already inactive;
  checkout opt-in afterwards re-stamps.
- Export (if built): only consenting customers, only the four columns, 403 without
  `customers.export`, audit has count and no PII.
- Customer list aggregate: counted-order definition matches `getPeriodTotals` omzet for one
  customer; masking function.

e2e (Playwright, `ammari_e2e`, memory private storage), **every list at 390 px and 1280 px**:

- Record an expense with a photo, see it in the list, void it with a reason, see it struck.
- Ringkasan tab shows Laba bersih and ROAS for a seeded month; Laba bersih tile on `/` for month
  only.
- Keuangan sees Iklan & Biaya but not Pelanggan; CS sees Pelanggan but not Iklan & Biaya and has
  no void/extend buttons; direct URL and action calls return the forbidden page/error.
- Customer list search and filters; masked contact in list, full on detail; detail sections.
- Voucher tab counts and "Segera berakhir"; owner voids and extends with reason; history row
  visible.
- Promo withdrawal by CS (with `customers.manage`).

### 12.2 Sessions (one feature each, committable alone)

| Session | Content | Reviewers |
|---|---|---|
| S1 | Migration 0042, Drizzle schema, constants, permissions.ts, pure functions (effective voucher status, allocation, ROAS) with TDD, migration test | database, typescript |
| S2 | Expense write paths (TDD), private-files purpose plumbing, `/ads-expenses` "Pengeluaran" tab, audit catalog + field labels, e2e | security, typescript, react |
| S3 | Expense figures: "Ringkasan" tab, Laba bersih tile on `/`, Perlu tindakan item, e2e | typescript, react, database |
| S4 | `/customers` list + `/customers/[id]` read-only, promo withdrawal action, e2e | security, react |
| S5 | Voucher tab: overview, void/extend (TDD incl. concurrency), Ringkasan voucher card, e2e | security, database |
| S6 | Promo export (A9), SPEC.md §3.2/§5.2/§6/§9 updates, contract-migration note for the old tables | security |

S1 to S3 (A) and S4 to S5 (B) are independent after S1; B can go first if the owner prefers.

---

## 13. Owner answers (2026-10-27)

All recommendations accepted (A2 confirmed separately on 2026-10-27). Each answer is folded into
the sections above; this list is the record.

| # | Question | Answer |
|---|---|---|
| A1 | Category list | Fixed list in code (the ten categories), "Lainnya" requires a note (G2). |
| A2 | Unused `expenses` and `ad_spend_daily` tables | **Confirmed by the owner (2026-10-27).** Keep both for now: 0042 leaves them untouched; a later cleanup (contract) migration drops them once dev and prod are confirmed to have 0 rows. Ad-platform-reported GMV can come back later as an import if wanted. |
| A3 | Monthly bills in short periods | Counted on the payment date; Laba bersih shown for whole months only, hidden for shorter periods (§4.2). |
| A4 | Web shipping subsidy | Subtracted automatically as its own line ("Subsidi ongkir situs"); Biteship/courier top-ups are never recorded as expenses (§4.1, §4.3). |
| A5 | Contacts in the customer list | Masked in the list, full on the detail page (§8.1). |
| A6 | Ringkasan hooks | Laba bersih tile (month only, finance), voucher card (`customers.view`), Perlu tindakan "Gaji/Sewa bulan lalu belum dicatat" from the 6th (§6, §9.2). Window and configuration (2026-10-27): the categories are chosen on `/settings` ("Pengingat biaya bulanan", default none = off; migration 0043); each chosen one needs its own non-voided expense dated from the 6th of last month through the 5th of this month (Jakarta); the item names the missing ones and links to the list for that window. |
| A7 | Recording a promo withdrawal | New key `customers.manage` for owner, super_admin and CS (§8.3; shipped in 0042). |
| A8 | Voucher void and extend | Both, owner and super_admin only, reason required, extension max 3 months, reusing `vouchers.void` relabelled "Batalkan atau perpanjang voucher" (§9.3). |
| A9 | Promo contact export | Yes, narrowly: consenting accounts only, four columns, owner/super_admin, audited, never uploaded to Meta/TikTok (§10; `customers.export` shipped in 0042). |
| A10 | Editing customer identity | No staff editing of name/email/phone (§8.3). |
| A11 | Self-serve "Berhenti terima promo" on `/account` | Yes, as a main-site task before the first promo send (outside this plan's sessions). |
| A12 | Voucher expiry reminders | "Segera berakhir" list only, nothing is sent from the admin (§9.2). |
| A13 | Customers from unpaid guest checkouts | Hidden by default in the list; covered by the 90-day anonymisation job (separate plan, due before 1 Mar 2027). |
| A14 | Meta ads channel | Optional channel tag on Meta and Endorse/KOL; untagged Meta spend only in total ROAS; Shopee/TikTok ads tied automatically. |
