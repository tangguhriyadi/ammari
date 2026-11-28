# Accounting module (double-entry general ledger)

Status: **Sessions 1-4 and 6-12 implemented** (migrations 0049-0056); Session 5: **TikTok replaced by
tiktok-shop-integration.md T5/T8** (real ship time = TikTok `collection_time`, migrations 0059/0062), **Shopee re-planned
28 Nov 2026** from the real "Pesanan Saya" export (§8 Session 5 → marketplace-import.md §19, sessions
7a-7f; no fee columns, so fees come from a "Penghasilan Saya" import; **part 1: 7a and 7b done 28 Nov
2026**, real ship/complete dates written, lock still on until 7c); MDR
W2/W5 off until fee work A/B. Originally: plan, Investigation date 2026-11-26
(branch `dev`, HEAD `aa2147f`). Revised 2026-11-26 with the owner's answers (Midtrans fee "A+B",
Biteship, no credit sales — §10), then with the **final policy decisions D-1..D-25 (owner +
accountant, 26 Nov 2026)**. The decisions live in
**[accounting-decisions.md](accounting-decisions.md)** (the source of truth; §11 is only an index).

Goal: a real double-entry ledger for Ammari (sole proprietor now, PT later), SAK EMKM, accrual
basis, IDR (whole rupiah, `bigint`), periods as Asia/Jakarta calendar months. Every rule below
marked **[D-n]** implements decided policy n.

**Hard constraint (launch 1 Dec 2026):** no change to any checkout, payment, stock, purchase,
production or expense write path. The ledger is **derived**: a posting service reads existing
source records and writes journals into new tables only. No existing function gains a call from
the ledger. Manual journals exist only for what the system does not record.

**Two deliberate exceptions (decided policy, after the launch freeze):** D-2 and D-3 each need a
**small feature that changes an existing write path**: the marketplace import stores the real
ship/complete dates (Session 5), and the manual-order form records payment method + destination
account (Session 6). Both are additive (new nullable columns / a new table, expand-only
migrations), run as their own reviewed sessions, and must be live before the 1 Jan 2027 cut-over.

---

## 1. Findings: sources of financial events today

All amounts are `bigint` whole rupiah. "Date" below = the column a journal would be dated by.

### 1.1 Orders (`orders`, `order_items`) — packages/db/src/schema/orders.ts

| Field | Meaning |
|---|---|
| `channel_id` | `shopee`, `tiktok`, `web`, `reseller`, `whatsapp`, `instagram`, `offline`. A **checkout** order is `payment_status IS NOT NULL` (always `web`); staff may also enter a manual `web` order. |
| `status` | `awaiting_payment → to_ship → shipped → completed`; `cancelled` (from awaiting_payment/to_ship); `returned` (from shipped/completed). `shipped → cancelled` is impossible (packages/commerce/src/orders/status.ts). |
| `order_date` | When the buyer ordered (management P&L dates omzet here). |
| `shipped_at`, `completed_at`, `cancelled_at`, `returned_at` | Stamped by `transitionOrderStatus` with `new Date()` **at the moment of the transition**. There is **no `to_ship_at`** (orders can be created at `to_ship`). |
| `paid_at`, `payment_status`, `payment_expires_at` | Checkout only. `payment_status` in `pending/paid/expired/cancelled/refunded/partially_refunded/chargeback`. |
| `subtotal_amount` | Σ qty × `unit_price` (product discounts are already inside `unit_price`). |
| `discount_amount` | Web: the redeemed thank-you voucher (`min(voucher.amount, subtotal)`). Marketplace: **seller-funded voucher** only ("Voucher Ditanggung Penjual"); platform vouchers/coins are not recorded. Manual: free-typed discount (may exceed goods, covering ongkir). |
| `shipping_amount` | What the **buyer** pays for shipping. Web: `shipping_cost_amount − shipping_subsidy_amount`. Marketplace: always 0 (buyer ongkir is pass-through, not recorded). Manual: typed. |
| `total_amount` | `subtotal + shipping − discount` (CHECK). |
| `shipping_cost_amount`, `shipping_subsidy_amount` | Web checkout only: quoted courier cost and the part Ammari covers (subsidy). |
| `order_items.unit_cost` | HPP per pcs, **frozen when stock leaves** (`decrementStockForOrderItems`), 0 before. |
| `order_items.list_unit_price` | Undiscounted price when a product discount applied (web/manual). |
| `needs_attention` | Flags incl. `refund_due`, `refund_received`, `paid_after_cancel`, `amount_mismatch`, `shipping_cost_over_quote`, `marketplace_return_pending`. |
| `channel_status`, `channel_synced_at`, `import_batch_id` | Marketplace import. |

**When stock (and HPP) leaves:** a `stock_movements` row `type='sale'` is written at
`awaiting_payment → to_ship` (checkout: on payment; staff orders: at creation when created at
`to_ship`; marketplace import: at creation, always `to_ship`). Valued at the SKU's moving average
(`valueDeltaForConsumption`), and the same value is snapshotted to `order_items.unit_cost`.
`cancelled` (after to_ship) and `returned` write an exact-negation `type='return'` row, whole
item only. So **finished-goods COGS has a clear, single, immutable event**: the `sale` movement
(`stock_movements.created_at`), with its exact reversal on cancel/return.

**Gap — imported order dates:** marketplace import walks statuses through
`transitionOrderStatus`, so an imported order's `shipped_at`/`completed_at`/`returned_at` are the
**import time**, not the marketplace's real date. A November order imported on 3 Dec looks
shipped in December. Only `order_date` (from the file) is real. **→ Resolved by D-2:** the import
will store the file's real ship/complete times (Session 5); the ledger dates marketplace revenue by them.

**Gap — manual orders have no payment record:** WhatsApp/Instagram/offline (and manual `web`)
orders carry no payment method, date, amount received or bank. Management P&L treats `to_ship` as
"paid". **Owner confirmed (2026-11-26): there are no resellers and no credit sales; a manual
order is always paid before it ships.** So a manual order never creates a receivable. **→ Resolved
by D-3:** staff will pick the payment method and destination cash/bank account per order (Session 6), so
the money posts straight to that account (§4.1 S6). The `reseller` channel id still exists in the
schema but is unused.

### 1.2 Midtrans payments (`payments`, `payment_notifications`) — schema/checkout.ts

One row per attempt: `provider='midtrans'`, `provider_order_id`, `provider_ref`, `gross_amount`,
`status` (`created/pending/paid/failed/expired/cancelled/refunded/partially_refunded/chargeback`),
`payment_type` (e.g. `bank_transfer`, `qris`, `gopay`; cards never enabled), `paid_at`,
`refunded_amount`, `last_status` (allowlisted JSON). Raw notifications are kept 12 months.

**Gaps today:** no MDR/fee, no settlement date, no payout record (Midtrans → bank).

**Planned "A+B" fee work** (owner's backlog, chosen 9 Nov 2026, built **after launch**, not in the
repo; a separate feature, not part of this ledger plan):

- **A — estimate.** A fee table in Settings, per payment method: percent + flat + PPN, with
  `effective_from`. When an order is paid, one `order_channel_fees` row of a **new component
  `payment_gateway_fee`** with **`source = estimate`** is written, computed on the payment's
  `gross_amount` (buyer-paid shipping included). Idempotent; backfilled from
  `payments.payment_type` for orders already paid. (Needs a CHECK widen for the component and a new
  nullable/defaulted `source` column on `order_channel_fees` — that feature's own migration.
  **Update 28 Nov 2026:** the `source` column (`estimate | actual`, default `actual`) shipped in
  migration 0061 with TikTok T7, which uses it for TikTok's estimated and actual fees (Q9); fee work A
  reuses it and adds only the component.)
- **B — actual.** Import of the Midtrans transaction/settlement CSV on `/import`, matching its
  `order_id` to `payments.provider_order_id`: overwrites the estimate with the actual fee
  (`source = actual`) and fills `order_settlements` (gross, fee, net, `settled_at`). An order whose
  fee is still `estimate` is "belum lengkap".
- **Refunds:** Midtrans does not return the MDR; the fee row stays.

The ledger consumes both (W2, W5 in §4.2) and only reads them; until A+B ship, W2/W5 simply have no
source rows and payouts are a manual journal.

### 1.3 Refunds (recorded by hand) — packages/commerce/src/payments/staff.ts

`recordManualRefund` sets one paid attempt to `refunded` (`refunded_amount = gross_amount`) and
clears `refund_due`. The **amount, note and timestamp exist only in `audit_log`**
(`action='record_refund'`, `after.amount`, `after.note`). No refund table, no refund date chosen
by staff, no record of *which* bank or whether it went through the Midtrans dashboard.
`partially_refunded`/`chargeback` arrive from the gateway status (`payments.updated_at`).

### 1.4 Marketplace import — packages/commerce/src/marketplace-import/commit.ts

Creates/updates Shopee orders (TikTok mapping prepared) at `to_ship` then steps through statuses.
`order_channel_fees` (one row per order × component: `admin_fee`, `service_fee`,
`platform_commission`, `affiliate_commission`, `seller_shipping_subsidy`, `other`) is upserted on
every re-import (amounts **mutable**). `discount_amount`/`total_amount` may also change on
re-import. **`order_settlements` exists but nothing writes it** (income/"Penghasilan" import is a
later plan), so marketplace payouts and seller-balance withdrawals are not recorded.

### 1.5 Purchases, receipts, supplier payments

- `purchases` (`purchase_no`, `supplier_id`, `ordered_at`, `status` ordered/partially_received/
  received/closed/cancelled, close/reopen stamps) and `purchase_items` (fabric+colour or
  accessory, `qty_ordered`, `total_amount` **including ongkir** (D6)).
- `goods_receipts`/`goods_receipt_items` (`received_at` date, `kind` receipt/reversal,
  `qty_accepted`, `qty_rejected`). Each accepted arrival writes a raw-material ledger row
  (`fabric_stock_movements`/`accessory_movements`, `type='purchase'`, `ref_type='goods_receipt'`,
  `ref_id` = receipt item) valued as a cumulative-rounding **slice of the line total**
  (apps/admin/src/lib/receipts/valuation.ts); rejects write `defect_movements type='reject'` at
  the defect share. Reversal = exact negation (`purchase_void`). Raw purchases are only ever
  written through receipts now (legacy `ref_type='manual'` rows predate this).
- `supplier_payments` (`payment_no`, `target_type` purchase|production_batch, `supplier_id`,
  `paid_at` date, `amount`, `method` cash|transfer, mandatory proof, append-only, void with
  `voided_at`/reason). DP and pelunasan are simply successive payments.
- Amount due ("tagihan", apps/admin/src/lib/supplier-payments/status.ts): an **open** purchase is
  due its **full ordered total even before anything arrives**; a closed one only what was settled;
  cancelled 0. Status `overpaid` ("Lebih bayar") when payments exceed tagihan (closed under DPs).
  A posted batch's tagihan = its service cost lines, grouped by payee (NULL = "Tanpa pemasok").

### 1.6 Defects — `defect_movements`, apps/admin/src/lib/defects

`reject` (at receipt), `return_out` (exchange: units back to supplier/tailor, re-opens exactly
that outstanding qty on the same line; **tagihan unchanged**, the replacement arrives through a
normal receipt), `dispose` with `disposal_type` auction/donation/discarded and
`proceeds_amount` (Lelang cash, **stored but booked nowhere**, SPEC §5.2), `reversal`. Valued
per source line, never moved between lines.

### 1.7 Production — schema/catalog.ts, apps/admin/src/lib/production/queries.ts (`postBatch`)

Draft → posted (frozen by triggers). At **posting** (`posted_at`): fabric consumed per colour
bucket (`fabric_stock_movements type='production'`) and accessories (`accessory_movements`) at
current moving average; `fabric_cost_amount` = fabric value; `production_batch_costs` lines
(variable/fixed, optional `product_id` scope, `supplier_id` payee). HPP per SKU:
`unit_cost = ceil(shared/totalPcs + scoped/productPcs)` frozen on `production_batch_items`.
Since migration 0025, **finished goods enter stock only at a production goods receipt**
(`stock_movements type='production'`, `ref_type='goods_receipt_item'`, qty × frozen unit cost);
production rejects go to `defect_movements` at qty × unit cost. `receipt_status`
pending/partially_received/received/closed (short-close with reason; reopen by a defect return).
So between posting and receipt the value is **work in progress, which no table stores** (it is
derivable: batch total cost − received value − rejected value). Because unit cost is rounded
**up**, received value slightly exceeds consumed cost (a few rupiah per batch); a short-closed batch
leaves unreceived cost behind.

### 1.8 Stock and valuation (moving average)

| Pool | Ledger | Value |
|---|---|---|
| Finished goods per SKU | `stock_movements` (production/sale/return/adjustment, append-only) | `SUM(value_amount)`; average = value/qty (packages/commerce/src/inventory/moving-average.ts) |
| Fabric per (fabric, colour bucket) | `fabric_stock_movements` (purchase/purchase_void/production/adjustment) | same moving average per bucket since 0046 |
| Accessories | `accessory_movements` | same |
| Defects per source line | `defect_movements` | `SUM(value_amount)` |

Adjustments (`reason` recount/damaged/lost/other) are valued at the average. Legacy: pre-0011
FG adjustments were backfilled to value 0; pre-0025 batches added stock at posting
(`ref_type='production_batch_item'`); pre-0046 fabric is colourless. All of this is before any
sensible cut-over date.

### 1.9 Business expenses — schema/expenses.ts

`business_expenses` (`expense_no`, `expense_date` = Jakarta day money left, `category` →
`expense_categories` (code, name, `kind` ad/endorsement/operating, `fixed_channel_id`,
is_system), `item_id` → `expense_items`, `amount`, `method` cash|transfer|card|platform_balance,
`channel_id` (ad/endorse only), mandatory proof, append-only, void stamp). Management P&L counts
them **cash basis** on `expense_date`. Categories include `material_shipping` (Ongkir bahan).

**Gaps:** no bank-account identity (only "transfer"; fine under D-17: one bank account); `card`
does not say debit or credit card (D-18: it is a debit card);
`platform_balance` names the marketplace only for Shopee/TikTok ad categories (operating
expenses paid from seller balance have `channel_id NULL`); no accruals (unpaid bills, salary owed).

### 1.10 Vouchers and shipping subsidy

`vouchers` (thank-you card, default Rp20.000, `used_order_id`, `used_at`) — issued free, no cash;
consumed as `orders.discount_amount` on a web order; restored if that order is cancelled.
Web shipping subsidy = `orders.shipping_subsidy_amount` (quoted). The courier price Ammari actually
pays per booking attempt is `shipments.cost_amount` (Biteship, NULL until known), with
`booked_at`, `cancelled_at` and `status` (one live attempt per order; a cancelled attempt can be
re-booked as the next attempt).

**Biteship billing (owner, 2026-11-26):** the owner **tops up a Biteship balance in advance**;
each booking's courier cost is **deducted automatically** from that balance; plus a separate
**monthly subscription** (Grow plan, ≈ Rp149.000). **Past top-ups were not recorded anywhere**
(no expense rows), so the system has no record of top-ups today; the subscription can be recorded
as a business expense (an expense item "Biteship Grow" exists). Return-shipping charges, if
Biteship deducts any, are not recorded either.

### 1.11 Not recorded anywhere

Bank/cash balances and bank accounts, owner capital and drawings (prive), loans, fixed assets
and depreciation, taxes (PPh final 0,5%), marketplace and Midtrans payouts, MDR, Lelang proceeds
as income, accrued expenses, prepaid expenses. `audit_log` exists (actor, action, entity, before/
after jsonb). Background work runs via the internal cron service hitting
`apps/web/src/app/api/internal/*` with `INTERNAL_CRON_SECRET` (docs/deploy.md §Internal cron).

### 1.12 The existing management P&L (for later reconciliation)

apps/admin/src/lib/overview/revenue-sql.ts + lib/expenses: **omzet** = `greatest(subtotal −
discount, 0)` (minus partial web refunds) for orders in `to_ship/shipped/completed` by
`order_date`; **laba kotor** = omzet − Σ qty × unit_cost; **laba setelah biaya platform** −=
`order_channel_fees`; **laba bersih** −= web shipping subsidy − non-voided expenses by
`expense_date`. Supplier payments never enter it (guarded by `accounting-guard.test.ts`).

---

## 2. Design overview

```
source records (unchanged)  ──read──►  posting rules (pure functions)  ──►  journal_entries / journal_lines
  orders, stock_movements,             one deterministic journal per            (append-only, balanced,
  payments, receipts, ...              (source_type, source_id, event)          period-locked)
```

- **Posting service** in a new `packages/accounting` (server-only, imports `@ammari/db`, never
  imported by commerce). Each rule is a pure function `snapshot → lines[]`; a runner loads
  snapshots, computes expected lines, compares with the active journal for that key and:
  nothing (identical) | insert (new) | **reverse + insert** (source changed, or rule version
  bumped). Running twice changes nothing (idempotent).
- **Key:** `(source_type, source_id, event)`, e.g. `('order','<uuid>','shipped')`,
  `('supplier_payment','<uuid>','void')`. At most one *active* journal per key; superseded ones
  stay with their reversal.
- **Date:** each event's own date (Jakarta). If that period is closed, the journal (or the
  correction) is dated the first day of the first open period and keeps `source_date` for
  reference. Rule-fix re-posting into a closed period requires reopening it (audited).
- **Triggers:** cron (nightly + every 15 min, new internal route) and a "Posting sekarang" button.
  Scans by `created_at`/`updated_at` watermarks plus a full re-check of open periods (sources are
  small: thousands of rows a month).
- **Unpostable sources** (unmapped expense category, unknown supplier, missing fee data) go to a
  `posting_issues` queue shown on the accounting home, never silently skipped.
- **Cut-over:** nothing dated before the cut-over date is posted; it lives in opening balances
  (§5.4). Events after cut-over on older records that are real economic events of their own (a
  return, a refund) are posted normally; each such event's journal is independent.
- **Voids (decided 26 Nov 2026, owner):** a void (E2, P4, and any later "exact negation of the
  original" event) is posted **only if its original has an active journal**. Otherwise it does
  nothing: no journal and **no posting issue**. A void negates a record, and an original dated
  before the cut-over was never posted, so its effect (or its absence) is already in the opening
  balances; posting the void alone would book money that never moved. The same rule holds a void
  back while its original is itself blocked by a posting issue (e.g. an unmapped category): the
  issue is shown once, on the original, and once it posts, the void follows in the same run. The
  rule emits the void with the key of its original (`requiresActiveJournalFor`); the runner checks
  it against the database, again under the key's lock.

### 2.1 New tables (one migration, nothing existing altered)

| Table | Purpose |
|---|---|
| `accounts` | `code` PK (`1-1501`), `name` citext unique, `type` (asset/liability/equity/revenue/contra_revenue/cogs/expense/other_income/other_expense/tax), `normal_balance`, `parent_code`, `is_header` (not postable), `is_system`, `system_key` unique nullable, `is_active`, `cash_flow_group` (operating/investing/financing/cash/none), bank fields (`bank_name`, `account_no_last4`) for cash/bank accounts, `sort_order`. Triggers: no DELETE once any line references it (and never for system rows); `code`, `type`, `system_key` immutable. |
| `account_mappings` | `mapping_key` PK → `account_code`: e.g. `revenue.channel.shopee`, `cash.method.transfer`, `expense.category.<code>`, `expense.item.<uuid>` (optional override), `supplier_payable.kind.service`. Lets the accountant point a system event at her own sub-account without code changes. Missing mapping → posting issue. |
| `fiscal_periods` | `month` (first day) PK, `status` open/closed, `closed_at/_by`, `reopened_at/_by/_reason`. |
| `journal_entries` | `id`, `entry_no` (`JU-YYYYMM-NNNN`, advisory lock like `document-number.ts`), `entry_date`, `source_date`, `source_type`, `source_id`, `source_event`, `rule_version`, `kind` (system/manual/opening/reversal/closing/depreciation), `reverses_entry_id`, `reversed_by_entry_id` (stamp only), `description`, `posted_by_staff_user_id` (NULL for the runner), `content_hash`, `created_at`. Partial unique `(source_type, source_id, source_event) WHERE reversed_by_entry_id IS NULL AND kind <> 'reversal'`. |
| `journal_lines` | `entry_id`, `line_no`, `account_code`, `debit`, `credit` (`>= 0`, exactly one `> 0`), `memo`, dimensions `channel_id`, `supplier_id`, `order_id`, `cash_account_code`. Deferred constraint trigger: Σdebit = Σcredit per entry, ≥ 2 lines. |
| `posting_runs`, `posting_issues` | Run log (counts, duration, errors) and the open-issue queue. |
| `fixed_assets`, `fixed_asset_events` | Asset register (§5.3). |
| `tax_settings` | PPh final settings [D-20], effective-dated, edited by the accountant (never constants in code): `effective_from` date PK, `taxpayer_type` (`individual`; `company` later), `taxpayer_label` ("istri pemilik, orang pribadi"), `npwp_registered_year` (2020), `rate_bps` (50 = 0,5%), `annual_exemption_amount` (500000000), `rate_valid_until` date nullable (NULL = no end; initial row **2026-12-31** per the original PP 55/2022, to be updated by the accountant once the PP 55 revision is confirmed), `note`, `updated_by`/`updated_at` (audited). Initial row inserted by the Session 1 migration (`ON CONFLICT DO NOTHING`). |
| `manual_journal_templates` (optional, Session 4) | Saved recurring manual entries. |

Immutability as elsewhere in this repo: hand-authored triggers refuse UPDATE/DELETE on journals
(except the one-time `reversed_by_entry_id` stamp) and refuse any insert whose `entry_date` is in a
closed period. CoA rows and permissions ship **in the migration** (`INSERT ... ON CONFLICT DO
NOTHING`), not only in `seed.ts` (CLAUDE.md rule).

---

## 3. Proposed Chart of Accounts (SAK EMKM style)

🔒 = system-locked (`is_system`, referenced by a posting rule through `system_key`: can be renamed
and get sibling sub-accounts under its header, cannot be deactivated or deleted, type never changes;
since Session 3 a parent is always a header, so e.g. a second bank goes under 1-1200 Bank beside
1-1201, never under 1-1201 itself). Everything else is
owner-managed in Data Master (**Akun**): add sub-accounts, rename, deactivate; **never delete once
used**. Codes are proposals; the accountant may renumber before go-live.

**1 ASET**
- 1-1000 Aset lancar (header)
  - 1-1100 Kas — 1-1101 Kas tunai 🔒 (`cash.method.cash`)
  - 1-1200 Bank — 1-1201 Bank utama 🔒 (`cash.method.transfer`, `cash.method.card` [D-17, D-18]); Ammari has **one** bank account [D-17]; a second one would be added as a sub-account
  - 1-1300 Saldo pembayaran & marketplace — 1-1301 Piutang Midtrans 🔒, 1-1302 Saldo Penjual Shopee 🔒, 1-1303 Saldo Penjual TikTok 🔒, 1-1305 Saldo marketplace belum dipilah 🔒 (clearing for unallocated marketplace-balance spend [D-11]); receivables for Arus kas, not cash (cash flow group `operating`, migration 0054)
  - 1-1400 Piutang — 1-1402 Piutang klaim pemasok (lebih bayar) 🔒, 1-1409 Piutang lain-lain (no trade receivable: there are no credit sales)
  - 1-1500 Persediaan — 1-1501 Persediaan bahan kain 🔒, 1-1502 Persediaan aksesoris 🔒, 1-1503 Barang dalam proses (produksi) 🔒, 1-1504 Persediaan barang jadi 🔒, 1-1505 Barang terjual belum dikirim 🔒, 1-1506 Persediaan barang cacat 🔒
  - 1-1600 Uang muka & dibayar di muka — 1-1601 Uang muka pembelian 🔒, 1-1602 Sewa dibayar di muka, 1-1603 Saldo Biteship (uang muka ongkir) 🔒
- 1-2000 Aset tetap (header) — 1-2101 Mesin & peralatan produksi, 1-2102 Peralatan kantor & komputer, 1-2103 Kendaraan, 1-2104 Bangunan/renovasi; 1-2191..2194 Akumulasi penyusutan (contra, one per class; locked once an asset class uses it)

**2 KEWAJIBAN**
- 2-1101 Utang usaha – pemasok bahan 🔒, 2-1102 Utang usaha – jasa produksi 🔒, 2-1103 Utang usaha – tanpa pemasok 🔒
- 2-1201 Uang muka pelanggan 🔒, 2-1202 Utang pengembalian dana pelanggan 🔒, 2-1203 Titipan ongkir pembeli 🔒 ([D-6])
- 2-1401 Utang PPh final 🔒, 2-1402 Biaya masih harus dibayar (gaji, listrik)
- *(No Utang kartu kredit: "Kartu" is a debit card [D-18]. Backlog: add a "Kartu kredit" method and 2-1301 Utang kartu kredit only if a credit card is ever used.)*
- 2-2101 Utang bank/pinjaman, 2-2201 Pinjaman dari pemilik

**3 EKUITAS**
- 3-1001 Modal pemilik 🔒 (PT later: Modal disetor), 3-1002 Prive 🔒
- 3-2001 Saldo laba 🔒, 3-2002 Laba (rugi) tahun berjalan 🔒 (computed, closing entry at year end)
- 3-9001 Ekuitas saldo awal 🔒 (opening balance plug, closed into Modal pemilik after approval)

**4 PENDAPATAN**
- 4-1100 Penjualan (header) — 4-1101 Website 🔒, 4-1102 Shopee 🔒, 4-1103 TikTok 🔒, 4-1105 WhatsApp/Instagram/Offline 🔒 (mapping `revenue.channel.<id>`; the unused `reseller` channel maps to 4-1105 so a stray order never blocks posting; she can split further)
- 4-1201 Potongan penjualan – voucher & diskon 🔒 (contra, [D-4]), 4-1301 Retur penjualan 🔒 (contra, [D-7])
- *(No Pendapatan ongkos kirim: buyer ongkir is a liability, 2-1203 [D-6].)*

**5 HARGA POKOK PENJUALAN** (only the cost of goods sold and the production rounding residue)
- 5-1101 HPP barang jadi 🔒, 5-1201 Selisih biaya produksi (pembulatan batch selesai normal) 🔒 [D-15]

**6 BEBAN USAHA**
- 6-1000 Penjualan & pemasaran — 6-1101 Iklan, 6-1102 Endorse/KOL, 6-1201 Biaya platform marketplace 🔒 [D-5], 6-1202 Subsidi ongkir penjual (marketplace) 🔒 [D-6], 6-1203 Biaya payment gateway (MDR, PPN included) 🔒 [D-8], 6-1301 Beban ongkos kirim penjualan (selisih kurir vs quote, ongkir retur, ongkir tanpa titipan) 🔒, 6-1302 Subsidi ongkir website 🔒 [D-6], 6-1401 Packaging
- 6-2000 Umum & administrasi — 6-2101 Gaji, 6-2201 Sewa, 6-2301 Utilitas, 6-2401 Beban penyusutan 🔒, 6-2501 Beban langganan aplikasi (Biteship Grow, VPS, …) 🔒 [D-10], 6-2901 Beban lain-lain 🔒 (default for unmapped "Lainnya")
- 6-3101 Ongkir bahan (separately recorded material shipping stays an expense [D-14])
- 6-4000 Beban persediaan (operating expense, **not** COGS [D-7, D-16]) — 6-4101 Selisih persediaan (opname/penyesuaian) 🔒, 6-4102 Kerusakan & kehilangan persediaan (rusak, hilang, sisa batch ditutup awal) 🔒 [D-15, D-16], 6-4103 Barang cacat dilepas (hibah/dibuang/lelang) 🔒 [D-7]

**7 PENDAPATAN LAIN-LAIN** — 7-1101 Hasil lelang barang cacat 🔒, 7-1102 Bunga bank, 7-1103 Selisih pembulatan/lain-lain
**8 BEBAN LAIN-LAIN** — 8-1101 Administrasi bank, 8-1102 Rugi pelepasan aset tetap
**9 PAJAK** — 9-1101 Beban PPh final 🔒

Initial mappings [D-25]: each existing expense category → one 6-xxxx account (`ads_*` → 6-1101,
`endorsement` → 6-1102, `packaging` → 6-1401, `salary` → 6-2101, `rent` → 6-2201,
`utilities` → 6-2301, `material_shipping` → 6-3101, `other` → 6-2901; item overrides: "Biteship
Grow" and other subscription items → 6-2501). Biteship **top-ups are never an expense** (they are
1-1603, §5.5); if the owner ever records one as a business expense, that item maps to 1-1603 so it
is not expensed twice. A category the owner
creates later is unmapped until mapped (posting issue, shown on the Kategori Biaya page too). A
category may also map to a liability (e.g. a "Pajak" category → 2-1401, "Bayar utang gaji" →
2-1402) so paying an accrual is not a second expense.

**Guard — raw-material purchases are inventory, never expense [D-14]:** fabric and accessories
reach the ledger only through goods receipts (P1 → 1-1501/1-1502); supplier payments (P3/R4) only
clear utang or build an advance and never touch a 5-/6- account. The mapping editor refuses to map
an expense category or item to 1-15xx, and no rule maps a purchase or supplier payment to an
expense. This mirrors `accounting-guard.test.ts` for the management P&L; Session 7 adds the ledger-side
test (every P1/P3/R4 line is on 1-15xx, 1-16xx, 1-14xx, 2-11xx or cash/bank).

---

## 4. Posting rules

Notation: `Dr A / Cr B  amount`. Dimensions (channel, supplier, order) on every line where known.
All rules are per **event**; their amounts come only from the source rows named.

### 4.1 Sales — every channel

| # | Event (key) | Date | Journal |
|---|---|---|---|
| S1 | Stock leaves: `stock_movements type='sale'` (`stock_movement`,id,`sale`) | movement `created_at` | Dr 1-1505 Barang terjual belum dikirim / Cr 1-1504 Persediaan barang jadi — `−value_amount` |
| S2 | Stock back: `type='return'` (`stock_movement`,id,`return`) | `created_at` | If the order had been recognised (S3 posted, i.e. it was returned after shipping): Dr 1-1504 / Cr 5-1101 HPP. Otherwise (cancelled before shipping): Dr 1-1504 / Cr 1-1505. |
| S3 | **Revenue recognised** (`order`,id,`recognised`) [D-1: at handover to the courier] | web/manual: `shipped_at`; marketplace: the real ship time from the export file [D-2] (§4.3 M1) | Dr *prepayment/balance* `total_amount` · Dr 4-1201 Potongan penjualan `discount_amount` [D-4] · Cr 4-110x Penjualan (by channel) `subtotal_amount` · Cr 2-1203 Titipan ongkir pembeli `shipping_amount` [D-6]; and Dr 5-1101 HPP / Cr 1-1505 `Σ qty × unit_cost`. *Prepayment/balance* = 2-1201 Uang muka pelanggan for checkout **and manual** orders (both paid before shipping), 1-1302/1-1303 Saldo Penjual (marketplace). |
| S4 | Returned after recognition (`order`,id,`returned`) | `returned_at` | Dr 4-1301 Retur penjualan `subtotal` · Dr 6-1301 Beban ongkos kirim `shipping_amount` (the courier was already paid through W9, so ongkir given back to the buyer is Ammari's cost; [D-7]) / Cr 4-1201 `discount` · Cr *refund liability* `total_amount` (2-1202 for web/manual; the marketplace Saldo Penjual account for Shopee/TikTok, which claws back). HPP side is S2 (back at the original cost [D-7]). |
| S5 | Re-import changes `discount_amount`/`total_amount` | — | Engine reverses S3 and re-posts with the new amounts; if the sale month is closed, the correction lands in the first open month [D-5, D-23]. |
| S6 | Manual order money in [D-3] (`order`,id,`collected`) — every non-checkout, non-marketplace order (always paid before shipping, no credit sales) | the **payment date** staff recorded (`order_manual_payments.paid_on`; owner, 26 Nov 2026) | Dr *the cash/bank account staff picked on the order* (`order_manual_payments.cash_account_code`, Session 6; free choice among the active Kas & Bank accounts, today Kas tunai 1-1101 or Bank utama 1-1201 [D-17]; method `card` = debit card, preselected 1-1201 [D-18]) / Cr 2-1201 Uang muka pelanggan `total_amount`. Same deposit pattern as the website (D-1, W1 then S3): **two journals**, this one on the paid date, then S3 on the ship date (Dr 2-1201 / Cr Penjualan, plus HPP). A corrected record (method, account or date changed after S6 posted) → the engine's normal reverse + repost; if the original month is closed, the correction lands in the first open month [D-23]. An order without a recorded method/account (created before the feature, or left blank) is a **posting issue**, never guessed; the feature lets staff fill it in afterwards. A cancel before shipping: Dr 2-1201 / Cr 2-1202 (money to give back), cleared by a manual journal when she refunds by hand. |

Rationale for 1-1505 (a sub-account of Persediaan): `Persediaan barang jadi` + 1-1505 then equal the
stock valuation (`Σ stock_movements`) plus to-ship cost exactly at any date, and HPP lands in the
same period as revenue. D-1's "shipped → Dr HPP / Cr Persediaan barang jadi" is exactly S3's
Dr 5-1101 / Cr 1-1505: the goods left the shelf at to_ship but stay in inventory until handover.

### 4.2 Web checkout / Midtrans

| # | Event | Date | Journal |
|---|---|---|---|
| W1 | Payment attempt paid (`payment`,id,`paid`) | `payments.paid_at` | Dr 1-1301 Piutang Midtrans / Cr 2-1201 Uang muka pelanggan `gross_amount`. A `paid_after_cancel` payment posts the same; W3 then moves it to refund liability. |
| W2 | MDR (`order_channel_fee`,id,`mdr`) — reads the `order_channel_fees` row `component = payment_gateway_fee` written by fee work **A** | the order's `paid_at` | Dr 6-1203 Biaya payment gateway / Cr 1-1301 Piutang Midtrans — the row's `amount` (percent + flat + PPN on `gross_amount`, buyer ongkir included; PPN is part of the cost because Ammari is not PKP, [D-21]). The journal keeps the row's `source`. When **B** overwrites the estimate with the actual fee (`source = actual`), the engine reverses the estimate journal and posts the actual one; if the paid month is already closed, the difference lands in the first open month ([D-8], [D-23]). Not reversed by any refund (Midtrans keeps the MDR). Until A ships there is no W2; the whole fee then surfaces as a difference at payout (W5). |
| W3 | Paid order cancelled (`order`,id,`cancelled_paid`) | `cancelled_at` | Dr 2-1201 / Cr 2-1202 Utang pengembalian dana — amount paid and not yet recognised. |
| W4 | Refund recorded (`payment`,id,`refunded`) | `audit_log.created_at` of `record_refund` (manual) or `payments.updated_at` (gateway `partially_refunded`/`chargeback`) | Manual refund: Dr 2-1202 / Cr 1-1201 Bank utama [D-9] (the accountant reclasses by manual journal if it actually went through the Midtrans dashboard). Gateway refund/chargeback: Dr 2-1202 / Cr 1-1301. Amount = `refunded_amount` delta (the full amount the buyer paid back; the MDR is **not** returned, so W2 stays [D-8]). |
| W5 | Midtrans settlement (`order_settlement`,id,`settled`) — fee work **B** fills `order_settlements` | `settled_at` | Dr Bank (mapping `cash.midtrans_payout`, default 1-1201) `net_amount` / Cr 1-1301 Piutang Midtrans `net_amount`. D-1's "settlement → Dr Bank + Biaya payment gateway / Cr Piutang Midtrans" is W2 + W5 together; per D-8 the fee half is dated at payment (W2), so W5 books only the net, and the fee is never taken from `order_settlements.fee_amount` (no double count). After W2(actual) + W5 the order's 1-1301 balance is 0; any rest shows on the Rekonsiliasi page. Before B ships: manual journal Dr Bank / Cr 1-1301 from the Midtrans payout email, with the difference to 6-1203. |
| W6 | Buyer ongkir at recognition (inside S3) | `shipped_at` | [D-6] buyer's `shipping_amount` → Cr 2-1203 Titipan ongkir pembeli (liability, never revenue). |
| W9 | Biteship booking charged (`shipment`,id,`charged`) — a shipment attempt with `cost_amount` set and `booked_at` set | `booked_at` | Dr 2-1203 Titipan ongkir the order's whole `shipping_amount` · Dr 6-1302 Subsidi ongkir website the order's `shipping_subsidy_amount` · Dr/Cr 6-1301 Beban ongkos kirim the rest, `cost_amount − shipping_amount − subsidy`, either sign (courier price above or below the quote) / Cr 1-1603 Saldo Biteship `cost_amount`. **Decided (owner, 27 Nov 2026): no "at most" caps**; the buyer's whole titipan is used at booking (Session 9). A later change of `cost_amount` → reverse + repost. A manual order booked through Biteship has no subsidy: everything above its `shipping_amount` → 6-1301 [D-10]. |
| W10 | Biteship booking cancelled after it was charged (`shipment`,id,`cancelled`) | `cancelled_at` | Exact negation of W9 (Biteship puts the money back on the balance). The re-booked next attempt posts its own W9. |
| W11 | Biteship top-up, subscription, return charges | — | Top-up: **manual journal** (template "Top-up Biteship") Dr 1-1603 / Cr Bank — the system has no record of top-ups ([D-10]). Subscription (Grow ≈ Rp149.000/month): a business expense (E1) with item "Biteship Grow" → 6-2501. Return-shipping or other deductions not in `shipments`: found when reconciling 1-1603 with the Biteship dashboard, booked by manual journal Dr 6-1301 / Cr 1-1603. |
| W7 | Voucher | at S3 | Contra revenue 4-1201 (the `discount_amount` in S3) [D-4]. No entry at issue, void or restore. |
| W8 | `amount_mismatch` | — | No special entry: the difference stays in 2-1201 and appears in the reconciliation (§6.3). |

### 4.3 Marketplace (Shopee, TikTok)

| # | Event | Date | Journal |
|---|---|---|---|
| M1 | Revenue | the order's **real ship time from the export file**, stored by the Session 5 import feature [D-2] | S3 with the balance account = 1-1302/1-1303 Saldo Penjual, Penjualan **gross** of fees [D-1]. Platform vouchers/coins are the platform's, not recorded. **Shopee (owner Q3, 28 Nov 2026):** every Shopee-funded discount, voucher and coin counts in Penjualan (Shopee pays it to the seller). Only seller-funded discounts go to 4-1201 (marketplace-import.md §19.2). No real ship time in the file yet (e.g. imported while still `to_ship`, or the column empty) → no M1, a posting issue until a later upload fills it; never the import time. The stored completed time is kept for reference and reconciliation only (recognition is at shipping [D-1]). |
| M2 | Platform fees (`order`,id,`channel_fees`) — every component **except** `payment_gateway_fee` (that one is W2) | same date as M1 [D-5] | Dr 6-1201 Biaya platform (`admin_fee`,`service_fee`,`platform_commission`,`affiliate_commission`,`other`) · Dr 6-1202 Subsidi ongkir penjual (`seller_shipping_subsidy`) / Cr Saldo Penjual. A re-upload that changes a fee → reverse + re-post; if M1's month is closed, the difference lands in the **first open month** [D-5]. **Shopee (28 Nov 2026):** the order export has no fee columns. Fees arrive only from the Penghasilan Saya import, as `source = actual`. Until then the order has no M2 (no fee rows means no journal, never zero fees), and the close warns (Session 5). |
| M3 | Withdrawal to bank / payout [D-11] | TikTok: the payout's `paid_time` (Jakarta) | **TikTok (T8): rule `tiktok_payout`** (`tiktok_payout`, payment_id, `paid_out`) from Get Payments, once TikTok reports it PAID: Dr `cash.tiktok_payout` (1-1201 Bank utama, Q17) / Cr 1-1303. **Shopee: manual journal for now:** Dr 1-1201 Bank utama / Cr 1-1302, from the bank statement. Penghasilan Saya lists releases *into* Saldo Penjual, not withdrawals, so **Decided Q4 (owner 28 Nov 2026):** Shopee withdrawals stay this manual journal (template "Penarikan Saldo Penjual Shopee"). Importing "Saldo Saya → Riwayat Transaksi" is a later item (marketplace-import.md §19.8). |
| M5 | TikTok statement adjustment (T8) | the statement's `statement_time` (Jakarta) | Rule `tiktok_adjustment` (`tiktok_statement_transaction`, id, `adjustment`): the signed settlement moves 1-1303 against the account the accountant mapped for its type (`tiktok.adjustment.<type>`, Pemetaan Akun); unmapped = posting issue `tiktok_adjustment_unmapped`, never guessed (ads suggested to 6-1101). |
| S7 | Refund-only, goods stay with the buyer (T8, Q10) | `marketplace_refunds.refunded_at` (Jakarta) | Rule `marketplace_refund` (`marketplace_refund`, id, `refunded`): Dr 4-1301 Retur penjualan / Cr Saldo Penjual, no HPP or stock line; held behind M1 while M1 is a posting issue. Ringkasan subtracts the same amount on the same date (Q19). |
| M4 | Expense paid from seller balance [D-11] | `expense_date` | Cr 1-1302/1-1303 when `channel_id` is set, else 1-1305 Saldo marketplace belum dipilah (owner reclassifies manually). |

### 4.4 Purchases, receipts, supplier payments (document-chain posting)

Utang is recognised at **receipt**, not at order (accrual, SAK EMKM, [D-13]) — unlike the app's
"tagihan", which is the full ordered total while a purchase is open. All events of one purchase
document are posted in date order (ties by `created_at`), so DP/uang muka is deterministic:

| # | Event | Date | Journal |
|---|---|---|---|
| P1 | Goods receipt item (`goods_receipt_item`,id,`received`) | `received_at` | Dr 1-1501 (fabric) or 1-1502 (accessory) raw-ledger value of that item · Dr 1-1506 Persediaan cacat reject value / Cr 1-1601 Uang muka pembelian up to the document's unapplied advance · Cr 2-1101 Utang usaha – pemasok bahan for the rest. |
| P2 | Receipt reversal | `received_at` of the reversal | The reversed item's stock lines negated + the position change (Session 7 position rule, §8.1): exact negation of P1 unless that would leave a wrong-side balance. |
| P3 | Supplier payment, purchase (`supplier_payment`,id,`paid`) | `paid_at` | Dr 2-1101 up to the document's open utang at that point · Dr 1-1601 Uang muka pembelian for the rest (DP before receipt, or over-payment) / Cr Kas/Bank by `method` (mapping `cash.method.*`, [D-17]). |
| P4 | Supplier payment void | `voided_at` (Jakarta date) | Dr Kas/Bank + the position change (Session 7 position rule, §8.1): exact negation of P3 unless that would leave a wrong-side balance. |
| P5 | Purchase closed with advance left ("Lebih bayar") (`purchase`,id,`closed_overpaid`) | `closed_at` | Dr 1-1402 Piutang klaim pemasok / Cr 1-1601. A reopen reverses it. |
| P6 | Defect returned to supplier (`defect_movement`,id,`return_out`, purchase line) | `occurred_at` | Dr 2-1101 (debit note: the supplier owes a replacement) / Cr 1-1506. The replacement receipt (P1) re-credits utang, so net utang = the tagihan. |
| P7 | Raw-material adjustment (`fabric/accessory_movement`,id) | `created_at` | Dr/Cr 1-1501/1-1502 vs 6-4101 Selisih persediaan (recount/other) or 6-4102 Kerusakan & kehilangan persediaan (damaged/lost) — operating expenses, not COGS [D-16]. Colour reclassification nets to zero inside 1-1501 (no journal, or a zero-sum memo journal). |

### 4.5 Production

| # | Event | Date | Journal |
|---|---|---|---|
| R1 | Batch posted (`production_batch`,id,`posted`) | `posted_at` | Dr 1-1503 Barang dalam proses = fabric + accessories + Σ cost lines / Cr 1-1501 fabric consumption · Cr 1-1502 accessory consumption · Cr 2-1102 Utang usaha – jasa produksi per payee (`supplier_id`; NULL → 2-1103). |
| R2 | Output received (`goods_receipt_item`,id,`received`, production) | `received_at` | Dr 1-1504 qty × unit_cost · Dr 1-1506 rejects qty × unit_cost / Cr 1-1503. Reversal: negation. |
| R3 | WIP closed (`production_batch`,id,`wip_close`) — **fully automatic, no manual step** [D-15] | when `receipt_status` becomes `received` or `closed` | The batch's remaining 1-1503 balance: **`received`** (completed normally; the rest is the ceil-rounding residue, a few rupiah, usually negative) → Dr/Cr 5-1201 Selisih biaya produksi (COGS). **`closed`** (short-closed early; the rest is the cost of the pieces never made, net of the rounding on those received) → Dr 6-4102 Kerusakan & kehilangan persediaan / Cr 1-1503 (operating expense [D-16]). Reopening the batch reverses R3; the next close re-posts. Example: Haura beige L, 12 planned, 6 made (cutting error), batch short-closed → the 6 missing pieces' cost goes to 6-4102. |
| R4 | Batch payment (`supplier_payment`,id,`paid`, production_batch) | `paid_at` | Dr 2-1102 (2-1103 when no payee) / Cr Kas/Bank; over-payment → 1-1601. Void: negation. |
| R5 | Defect returned to tailor (production line) | `occurred_at` | Dr 1-1503 / Cr 1-1506 (goes back into process; the replacement receipt R2 takes it out again). |

### 4.6 Stock adjustments, defects released

| # | Event | Journal |
|---|---|---|
| A1 | FG `stock_movements type='adjustment'` [D-16] | Dr/Cr 1-1504 vs 6-4101 Selisih persediaan (recount/other) or 6-4102 Kerusakan & kehilangan persediaan (damaged/lost), at `value_amount`. Operating expenses, not COGS. |
| A2 | Defect `dispose` [D-7] | Dr 6-4103 Barang cacat dilepas (operating expense) / Cr 1-1506 `value` (donation, discarded and auction alike); auction proceeds: Dr 1-1101 Kas tunai [D-17] / Cr 7-1101 Hasil lelang barang cacat (Pendapatan lain-lain) `proceeds_amount`. Reversal: negation. |

### 4.7 Business expenses

| # | Event | Date | Journal |
|---|---|---|---|
| E1 | Expense recorded (`business_expense`,id,`paid`) | `expense_date` | Dr mapped account [D-25] (`expense.item.<id>` if set, else `expense.category.<code>`; unmapped → posting issue) / Cr by method: cash → 1-1101, transfer → 1-1201 [D-17], card (debit) → 1-1201 [D-18], platform_balance → M4. |
| E2 | Expense voided | `voided_at` | Exact negation. |
| E3 | Accruals and prepayments | — | Manual adjusting journals (§5.5), e.g. Dr 6-2101 / Cr 2-1402 at month end; the later payment's category mapped to 2-1402. |

### 4.8 Rounding and invariants the engine asserts

Every journal balances; every amount is an integer; per-source totals equal the source's own
figures (e.g. Σ P1 for a closed line = its settled tagihan). A rule that cannot balance raises a
posting issue instead of plugging silently. Purchase-side rules (P1–P7, R1, R4) never post to a
5-/6- account except the adjustment and WIP-close accounts named above (§3 guard, [D-14]).

---

## 5. Manual entries

All manual journals: balanced, dated in an open period, description required, optional
attachment (re-use `private_files` with a new purpose `journal_attachment` — a CHECK widen in the
new migration, additive), audit-logged, corrected only by reversal.

1. **Setoran modal:** Dr Bank / Cr 3-1001. **Prive:** Dr 3-1002 / Cr Kas/Bank (also for personal
   items taken from stock, at cost [D-7]: the stock adjustment posts A1 as usual, then a manual
   reclass journal Dr 3-1002 / Cr the account A1 used (6-4101 or 6-4102) at the same value, so the
   stock ledger stays the single truth).
2. **Cash/bank accounts list** [D-17]: Data Master → Akun, filter "Kas & Bank": name, bank, last 4
   digits, active. Today exactly two: 1-1101 Kas tunai and 1-1201 Bank utama; this same list feeds
   the manual-order account picker (Session 6, [D-3]). `cash.method.transfer` and `cash.method.card`
   point at 1-1201.
3. **Fixed assets** [D-19]: register (name, tax group, acquisition date, cost, account set);
   method straight line, **residual value 0**, useful life from the tax group (**Kelompok 1 = 48
   months, Kelompok 2 = 96 months**; a group → months setting, not a constant), depreciation
   **starting in the acquisition month**. Capitalisation threshold **Rp1.000.000** (a setting): a
   purchase below it is an ordinary expense, and the register refuses an asset below it.
   Acquisition journal (Dr 1-21xx / Cr Bank or Utang); a generated monthly depreciation journal per
   asset (`fixed_asset`,id,`dep:YYYY-MM`: Dr 6-2401 / Cr 1-219x = cost / life, last month absorbs
   rounding); disposal (Dr Kas, Dr Akumulasi, Cr Aset, Dr/Cr 8-1102).
4. **Opening balances (saldo awal)** as of **31 Dec 2026** for the **1 Jan 2027** cut-over [D-22]
   (December 2026 is a trial month: the engine posts it, it is never locked, and its journals are
   not part of the official books): one `kind='opening'` journal dated the cut-over day. System-proposed lines (owner confirms each): 1-1501/1-1502/1-1504/1-1506 from the
   ledgers as of cut-over; 1-1503 from posted, not-fully-received batches; 1-1505 from orders at
   `to_ship`; 2-1101/2-1102 from received-not-paid per supplier; 1-1601 from DPs on unreceived
   lines; 2-1201 from paid web and manual orders not yet shipped; Saldo Penjual, Piutang Midtrans
   and **Saldo Biteship (1-1603)** **typed** from the platforms' dashboards (past top-ups were never
   recorded, so the dashboard balance on the cut-over day is the only source); Kas/Bank typed from
   bank statements; fixed assets typed; difference → 3-9001, then closed to 3-1001 once approved.
   **Trial month and official books (settled in Session 4, 26 Nov 2026).** The ledger holds two
   separate sets of books, split by `entry_date` (packages/accounting/src/books.ts):
   - *Trial books*: entries dated 2026-12-01..2026-12-31. The engine posts December so every rule
     is exercised; the month is never closed and is never part of the official books.
   - *Official books*: entries dated on or after 2027-01-01, starting from the ONE active
     `kind='opening'` journal, dated exactly 2027-01-01 (CHECK + partial unique index, migration
     0052). Its lines come from the source ledgers and the typed balances as of the end of
     31 Dec 2026, never from December's journals.
   - Every balance is summed within one set only: a report's opening balance starts at its
     segment's first day (1 Dec 2026 or 1 Jan 2027). A range crossing the cut-over starts at
     1 Jan 2027 (December is reported on its own, with a note). In the official books the opening
     journal (and a reversal of it) counts as the opening balance, never as January's movement.
     Neraca saldo, Buku besar and the close's balance check all follow this rule.
   - A void (any event that only negates its original, plan §2) is posted only when its original's
     active journal is in the same set of books: a December original voided in 2027 posts nothing
     in 2027 (the opening journal already reflects the correction; the opening proposals ignore
     voided payments). Reversals of December journals (re-maps, rule bumps) are dated in December,
     which is never closed, so they never touch 2027 either.
   - The opening journal is posted only from 1 Jan 2027 (the proposals need complete 2026 data). A
     wrong one is reversed and re-entered while January 2027 is open; reversing it while January is
     closed is refused (reopen January first).
   - Manual journals may be dated in December 2026 even before it starts (practice only).
5. **Adjusting entries:** accruals, prepaid amortisation, refund reclasses (a manual refund that
   went through Midtrans [D-9]), Midtrans/marketplace withdrawals (M3 [D-11], W5 before fee work B),
   **Biteship top-ups** (template: Dr 1-1603 / Cr 1-1201, one per top-up from the bank statement
   [D-10]) and unexplained Biteship deductions (W11), clearing 1-1305 [D-11].
6. **PPh final accrual** [D-20] (`tax`,`pph_final`,`YYYY-MM`; generated at month close, shown to
   the accountant before posting): Dr 9-1101 Beban PPh final / Cr 2-1401 Utang PPh final.
   - **Base** for month m = the month's net sales on the ledger: Cr 4-110x − Dr 4-1201 Potongan
     penjualan − Dr 4-1301 Retur penjualan (so: after vouchers, **excluding ongkir**, which is never
     revenue; marketplace sales **gross before fees**, which are expenses; net of returns).
   - **Exemption** per tax year (Jan–Dec): taxable(m) = max(0, YTD base through m − exemption) −
     max(0, YTD base through m−1 − exemption). The cut-over on 1 Jan makes YTD start clean.
   - **Accrual** = max(0, taxable(m) × `rate_bps` / 10000), rounded down to whole rupiah per month, using the
     `tax_settings` row effective for month m (§2.1). **Never negative** (owner, 27 Nov 2026): a month with negative net
     sales books nothing and never reverses an earlier month's accrual; the exemption stays measured on the net YTD base,
     so the headroom a negative month frees is used by the next months' sales first (worked example in §8.1, Session 11).
   - **After `rate_valid_until`**: no accrual is proposed; month close shows a warning
     ("tarif PPh final berakhir, periksa pengaturan pajak"). With the initial setting (end
     2026-12-31) this warning fires for January 2027 until the accountant enters the extended
     date from the PP 55 revision.
   - Payment via a "Pajak" expense category mapped to 2-1401 [D-25], so paying is not a second
     expense.
7. **Year-end closing** (generated): revenue/expense accounts → 3-2001 Saldo laba; Prive → Modal.
8. **Becoming a PT** [D-24]: the sole-proprietor books are closed on the transfer date (final
   closing entry, all periods locked); the PT starts as a separate set of books with its own
   opening journal (assets and liabilities transferred, Modal disetor) and its own `tax_settings`
   row (`taxpayer_type = company`). Multi-entity support is out of scope of this plan.

---

## 6. Reports

All under a new **Akuntansi** menu, period picker (month / range / year), Jakarta dates, export
**PDF and Excel** (re-use the patterns of apps/admin/src/lib/expenses/report-pdf.ts and
report-xlsx.ts), every figure drillable to the journal and its source document.

| Report | Content |
|---|---|
| Jurnal umum | Entries with lines, filter by source type / account / kind; reversals linked. |
| Buku besar | Per account: opening balance, lines, running balance; sub-ledger filter by supplier, channel, order. |
| Neraca saldo | All accounts, opening / debit / credit / closing; must balance. |
| Neraca (Laporan posisi keuangan) | SAK EMKM layout; comparative to previous period end. |
| Laba rugi | Penjualan − potongan − retur = Penjualan bersih; − HPP (5-1101 + 5-1201 Selisih biaya produksi) = Laba kotor; − beban usaha (incl. 6-4000 Beban persediaan: barang cacat dilepas, selisih persediaan, kerusakan & kehilangan [D-16]); ± lain-lain; − PPh final = Laba bersih. Per month columns option, per channel option. |
| Arus kas | **Direct method** proposed (readable for the owner: "uang masuk dari penjualan, keluar ke pemasok"): every line on a cash account (`cash_flow_group = 'cash'`: Kas tunai and the bank accounts only) classified by the counter-account's `cash_flow_group`. **Decided (owner + accountant, 27 Nov 2026):** Piutang Midtrans (1-1301) and the marketplace balances (1-1302, 1-1303, 1-1305) are receivables, not cash (group `operating`, migration 0054), so a Midtrans or marketplace sale is cash in only when the money reaches Kas/Bank (W5 payout, M3 withdrawal), shown on the operating line of that receivable. Indirect also derivable later. Note: SAK EMKM's required statements are Neraca, Laba rugi and CALK; arus kas is extra. |

### 6.3 Reconciliation checks (a "Rekonsiliasi" page; each red line links to the cause)

1. Ledger 1-1504 = Σ `stock_movements.value_amount` at date; 1-1501 = Σ fabric; 1-1502 = Σ
   accessories; 1-1506 = Σ defects; 1-1505 = Σ HPP of orders whose sale movement exists and S3 not
   yet posted; 1-1503 = per batch cost − received − rejected (open batches).
2. Utang usaha per supplier vs the app's supplier balances: difference = **ordered-not-received**
   (tagihan counts it, the ledger doesn't) ± advances; shown per document.
3. Uang muka pelanggan = paid web and manual orders not yet recognised and not refunded.
3a. **Piutang Midtrans** per order: paid − MDR − settled − refunded via gateway = 0 once settled;
   list orders still open and the count of MDR rows still `source = estimate` ("belum lengkap") for
   the month. Closing a month with estimates left is allowed but warned [D-8].
3b. **Saldo Biteship:** ledger 1-1603 vs the balance typed from the Biteship dashboard at month end;
   the difference (missing top-up journal, return charges) is listed for a manual journal.
3c. **Titipan ongkir 2-1203** per order: buyer ongkir received − ongkir paid to the courier = 0 once
   shipped and booked; orders with a rest are listed (e.g. shipped without a Biteship booking).
4. Laba rugi vs the management P&L (§1.12), with each difference explained in its own line:
   revenue timing (`order_date` vs recognition date), ongkir treatment, accrual vs cash expenses,
   stock adjustments/defects/production variance (not in management P&L), depreciation, MDR, PPh,
   partial refunds, entries before cut-over.
5. Posting completeness: every source event after cut-over has an active journal or an open issue.

---

## 7. Period close, reversals, audit, permissions

- **Close** a month [D-23], target **by the 10th of the next month** (the accounting home shows the
  deadline and what is still missing: marketplace uploads, Midtrans report, bank matching):
  requires no open posting issues for it (or an explicit, reasoned override) and a balanced trial
  balance; **warns** (does not block) when MDR rows are still `estimate` [D-8] or the PPh final
  rate has passed `rate_valid_until` [D-20]; sets `closed`. The DB trigger then refuses new lines
  dated in it; later corrections land in the first open month. December 2026 is the trial month
  and is never closed [D-22].
- **Reopen** only by the owner or the accountant (`accounting.close`) with a **written reason**
  (required, stored on `fiscal_periods.reopened_reason` and in `audit_log`). Year close also
  generates §5.7.
- **No edits, ever:** journals are append-only; a wrong manual journal is reversed and re-entered;
  a system journal is re-derived by the engine (reverse + new).
- **Audit:** every manual action writes `audit_log` (existing table); posting runs in
  `posting_runs`; each journal stores `rule_version` and `content_hash`.
- **Permissions** (new keys, shipped in the migration, owner gets them by default; super_admin
  all):
  - `accounting.view` — reports, ledgers, reconciliation.
  - `accounting.manage` — CoA and mappings, manual/opening journals, fixed assets, tax settings,
    run posting.
  - `accounting.close` — close/reopen periods, year-end closing.
  
  Not `finance.view_profit`: that gates the management figures for the Keuangan role, which may
  be a staff member; the books (owner capital, prive, bank balances) are more sensitive. Proposal:
  the predefined `finance` role gets **none** of these by default; the owner grants them.

---

## 8. Sessions (each ends with tests passing; no deploy in launch week)

Sessions 1–4 and 7–12 add only new tables and pages and touch no existing write path. **Sessions 5 and 6 are
the two decided small features [D-2, D-3] and do change existing write paths** (marketplace import;
manual-order form), so they run after the launch freeze like everything else, each with its own
`/plan`. Order and timing: start Session 1 after the freeze (≥ 8 Dec); **Sessions 1–6 must be live before the
1 Jan 2027 cut-over** (5 and 6 so that every January order carries the data its journal needs; the
December trial month [D-22] exercises them). Sessions 7–12 may continue in January: the engine posts
from the cut-over date whenever a rule lands, and January closes by 10 Feb [D-23].

| Session | Scope | Tests |
|---|---|---|
| 1 | Migration: `accounts`, `account_mappings`, `fiscal_periods`, `journal_entries`, `journal_lines`, `posting_runs`, `posting_issues`, **`tax_settings`** (initial PPh final row [D-20]); triggers (balance, immutability, period lock, no-delete-once-used); CoA (§3, incl. 6-4000 Beban persediaan) + mappings + 3 permissions inserted by the migration; `packages/accounting` skeleton. | DB: migration test (seed rows present, idempotent re-run), each trigger refuses the bad write, balanced/unbalanced inserts, closed-period insert refused. |
| 2 | Posting engine (pure rules + runner: insert / no-op / reverse+repost, cut-over filter, issues queue) with **expenses (E1–E2) and supplier payments (P3–P4, R4 without chain)**; pages Jurnal umum + Buku besar. **First useful report.** | Unit: each rule snapshot → lines, balanced; card → 1-1201 [D-18]. DB: run twice = no new rows; void → reversal; changed mapping + rule bump → reverse+repost; closed period → correction dated in first open period. e2e: Jurnal umum + Buku besar at 390 px and 1280 px. |
| 3 | Data Master **Akun** (list, add sub-account, rename, deactivate, bank fields; Kas & Bank filter = Kas tunai + Bank utama [D-17]) + **Pemetaan akun** (expense categories/items, methods, channels; refuses 1-15xx targets [D-14]; unmapped categories warned [D-25]); **Pengaturan pajak** form for `tax_settings` [D-20]; issues shown on the Kategori Biaya page. | Unit: validation (rate in bps, exemption ≥ 0, end date optional). DB: delete-once-used refused, system rows locked, mapping to inventory refused, tax-settings edit audited. e2e list pages at 390/1280. |
| 4 | Opening balances wizard (system-proposed lines + typed ones, as of 31 Dec 2026 [D-22]), manual journals (with attachment; templates for Biteship top-up, marketplace withdrawal, refund-via-Midtrans reclass), period close/reopen (deadline, warnings, written reason [D-23]), **Neraca saldo** + PDF/Excel. | DB: opening journal balances; close blocks posting; reopen without reason refused, with reason audited; trial month never closable. e2e: manual journal create/reverse, Neraca saldo at 390/1280. |
| **5** | **Feature D-2: real marketplace dates, Shopee** (TikTok done in T5/T8). **No migration:** `orders.marketplace_shipped_at`/`_completed_at` exist since 0059. **Part 1** = marketplace-import.md sessions **7a** (real 49-column mapping, lock stays) + **7b** (col 7 "Waktu Pengiriman Diatur" → `marketplace_shipped_at`, stored only once Shopee says shipped; col 48 "Waktu Pesanan Selesai" → `marketplace_completed_at`; write-once, on create and every re-upload; never touches the app's `shipped_at`/`completed_at`) + **7c** (unlock after the owner's checklist). **Part 2** = **7d/7e** (Penghasilan Saya import: actual fees, `order_settlements`, refund-only rows, return date = refund date [Q5]) + **7f** (accounting below). Owner decisions Q1-Q8 recorded 28 Nov 2026 (below). No "upload by the 3rd" rule. | 7a/7b/7c: see marketplace-import.md §19.9 (column parsing, empty → NULL, malformed → row error, status-gated, write-once, re-import never clears; M1/M2 post on col 7's Jakarta date; the `marketplace_ship_date_missing` issue clears). 7f: close warning lists Shopee orders recognised in the month with no actual fee rows; Rekonsiliasi Shopee per order (1-1302 lines vs Σ settlement net); S7 for a Shopee refund-only row; a Shopee order through shipped → income imported → manual withdrawal journal leaves 1-1302 at 0; S4 dated by the refund date (fallback: import time). `silent-failure-hunter` on all import code. |
| **6** | **Feature D-3 — manual-order payment.** New table `order_manual_payments` (`order_id` PK, `method` cash/transfer/card, `cash_account_code` → `accounts`, recorded by/at; audited), written by the manual-order create/edit form; **required** for new WhatsApp/Instagram/offline/manual-web orders; account picker lists active Kas & Bank accounts (today Kas tunai + Bank utama [D-17]), defaulting from the method mapping; an "isi metode bayar" action fills it for older orders. No credit option. | Unit: method → default account; card → Bank utama. DB: order + payment row in one transaction; missing row → posting issue (once Session 9 posts rule S6). e2e: create a manual order with method/account at 390/1280. |
| 7 | Purchases chain: P1, P2, P3 (with chain), P5, P6, P7; reconciliation checks 1 (bahan) and 2 (utang); **ledger-side guard test** that purchase/payment rules never debit an expense [D-14]. | Unit: chain allocation (DP before receipt, partial receipts, reversal returns advance, overpaid close). DB: against real receipts from fixtures; Σ P1 = tagihan for closed docs. |
| 8 | Production: R1–R5, A1, A2; reconciliation for 1-1503/1-1504/1-1506. | Unit: R3 split — normal completion residue → 5-1201, short-close rest → 6-4102 [D-15]; A1/P7 → 6-4101/6-4102 [D-16]; scoped cost lines. DB: post → receive partially → short-close (the Haura beige L case: 12 planned, 6 received) → reopen → close; ledger = stock valuation. |
| 9 | Sales: S1–S6 (S6 reads `order_manual_payments`, dated `paid_on`; a corrected record → reverse + repost into the first open month), W1, W3, W4, W6–W11, M1 (real dates from Session 5), M2, M4; checks 3, 3b, 3c. W2/W5 rule code + tests ship here against fixture rows shaped like fee work A/B (component `payment_gateway_fee`, `source`, `order_settlements`); they post real data only once A+B are deployed. | Unit: per channel × status path (paid→shipped→completed; paid→cancelled→refunded; shipped→returned; re-import fee change into a closed month → first open month); marketplace order without real ship date → issue; manual order without a payment record → `manual_payment_missing`; S6 on `paid_on` then S3 on the ship date; payment record corrected after posting (incl. into a closed month) → reversal + repost in the first open month. DB: through `transitionOrderStatus` fixtures; 1-1504 + 1-1505 = stock valuation + to_ship cost. |
| 10 | **Neraca, Laba rugi, Arus kas** + PDF/Excel; reconciliation 4 (vs management P&L) and 5. | Unit: statement layout from a trial balance (6-4000 under beban usaha, not HPP). e2e: each report at 390/1280, export downloads. |
| 11 | Fixed assets + depreciation [D-19] (tax groups, zero residual, from acquisition month, Rp1.000.000 threshold), **PPh final accrual** from `tax_settings` [D-20], year-end closing; turn on W2/W5 and check 3a once fee work A+B (a separate post-launch feature) is live. | Unit: depreciation schedule (rounding in last month); PPh base/exemption crossing Rp500 juta mid-month; no accrual after `rate_valid_until`; rate change by a new effective row. DB: closing zeroes P&L accounts. e2e: asset register + tax settings at 390/1280. |
| 12 | Cron route for nightly/15-min posting, Rekonsiliasi page polish, docs (SPEC §5.x, runbook). | DB: concurrent runs serialise (advisory lock), no duplicates. |

Every session: `/plan` approval first, `database-reviewer` + `typescript-reviewer` +
`react-reviewer` at `/code-review`, and the migration file read before committing.

**Session 5, TikTok: replaced (28 Nov 2026)** by tiktok-shop-integration.md T5 (the sync writes
`orders.marketplace_shipped_at` = TikTok `collection_time`, `marketplace_returned_at`) and T8 (the sales loader
reads both; no `SALES_RULE_VERSION` bump). The TikTok file import and its column mapping are no longer needed.
The text below now applies to **Shopee only**.

**Session 5 status (28 Nov 2026): unblocked for Shopee, planned in marketplace-import.md §19.** The
owner's real "Pesanan Saya" export (27 Nov 2026) has the ship time ("Waktu Pengiriman Diatur", col 7)
and the complete time ("Waktu Pesanan Selesai", col 48). Both are text `YYYY-MM-DD HH:MM` in Jakarta
time, and blank is `""`. The previous blocker (26 Nov) asked for exactly this. Whether the values
repeat on every row of a multi-item order is still open (O1-a). Until 7b ships, a Shopee order stays a
`marketplace_ship_date_missing` posting issue (never the import time). 7b checks that the
opening-balance 1-1505 proposal uses the recognition date, not `orders.shipped_at`. **Done in 7b (28
Nov 2026):** the import writes `marketplace_shipped_at`/`_completed_at` (marketplace-import.md §19.3
"As built in 7b"); M1 posts on col 7's Jakarta date through the existing loader, no rule or version
change, nothing already booked reposts; the 1-1505 opening proposal now uses the recognition date
(it used `orders.shipped_at`, which for a marketplace order is the import time).

**Owner decisions (28 Nov 2026)** (full text: marketplace-import.md §19.10):

- **Q1** Col 7 "Waktu Pengiriman Diatur" **is** the D-1 ship/handover date, stored only once Shopee
  reports the order as shipped. M1/M2 are dated by its Jakarta date.
- **Q2** Fees are **actual only**, from Penghasilan Saya. No rate-based estimate. The close warns about
  orders without fees (option A below).
- **Q3** Shopee-funded discounts, vouchers and coins **count in revenue** (Penjualan). Only
  seller-funded discounts go to 4-1201 [D-4].
- **Q4** Withdrawals stay a **manual journal** ("Penarikan Saldo Penjual Shopee"). The balance
  transaction import is a later item.
- **Q5** The Shopee **return date (S4) = the refund date from Penghasilan Saya**. Import time is only
  the fallback.
- **Q6** The owner fills the Shopee and TikTok seller SKUs next week, before launch. Until then the
  rows are held.
- **Q7** No buyer note is stored for Shopee.
- **Q8** Penghasilan Saya is imported **weekly, plus once before the 8th** for the month close (D-23).

**Shopee fees without fee columns (D-5): DECIDED, option A (owner Q2, 28 Nov 2026).**
The order export has no commission, admin or service fee. Options:

- **A. Actual only, from a "Penghasilan Saya" import (chosen).** M1 posts revenue on the ship
  date (col 7). M2 posts when the income import writes the actual `order_channel_fees` rows
  (`source = actual`). M2 is dated by M1's date [D-5], so an income file imported before the month
  closes puts the fee in the right month. A file imported after the close puts it in the **first
  open month** [D-23], which is the engine's normal reverse + repost. The month close **warns**
  (never blocks) with the Shopee orders recognised in the month that have no actual fee rows yet
  (count + 5 order numbers), the same as TikTok's estimate warning (Q9). If the amount matters, the
  accountant books a reversing manual accrual (Dr 6-1201 / Cr 1-1302), using a new manual-journal
  template "Akrual biaya Shopee", so no figure is invented by code. Shopee releases funds a few days
  after completion, so with the import before the 8th (Q8) the late-month orders are usually covered.
- B. Rate-based estimate (a Settings table of bps per component, `source = estimate`, replaced by the
  actual). Rejected: Shopee's fees depend on category, program (Gratis Ongkir Xtra, cashback), per-item
  caps and a fixed per-order fee, so a rate table would be wrong per order. It would also break
  marketplace-import decision 8 (no 18% and no estimates in Ringkasan). TikTok's estimates are
  different: TikTok computes them itself (unsettled transactions). Shopee's order file gives nothing
  comparable.
- C. Fees only at payout (net revenue). Rejected: it breaks D-1 (revenue gross of fees) and D-5.

**Withdrawals (D-11, M3): DECIDED (Q4).** Penghasilan Saya records releases into Saldo Penjual Shopee
(1-1302), not withdrawals to Bank utama. Withdrawals stay the manual journal "Penarikan Saldo
Penjual Shopee" (Dr 1-1201 / Cr 1-1302). Importing "Saldo Saya → Riwayat Transaksi" is a later item,
outside Session 5 (marketplace-import.md §19.8).

**Returns and refunds:** a return with goods back is S4 + S2 through the order import (col 2 value
mapped by the owner, marketplace-import.md §19.4). S4 is dated by the **refund date from
Penghasilan Saya** (Q5, `marketplace_returned_at`, written by 7e). Only while no refund row is imported
does it fall back to the import time. A later refund row reposts S4 on the refund date (closed month →
first open month). A refund-only row from the income import goes to
`marketplace_refunds` and posts the existing channel-generic **S7** (Dr 4-1301 / Cr 1-1302). Partial
returns stay Perlu dicek (O2).

**Session 5 part 2 (7f) accounting scope:** Shopee close warning (above); Rekonsiliasi "Shopee
(Penghasilan)": per order, 1-1302 lines vs Σ `order_settlements.net_amount` (not released yet =
waiting); the 1-1302 balance vs released-not-withdrawn (only once withdrawals are imported); opening
1-1302 hint ("Saldo Penjual" from Seller Center, typed by hand); the "Akrual biaya Shopee" template.
No M3 rule (Q4) and no new reference data, so no migration is expected. Rules are added at version 1 with their own source types.
`SALES_RULE_VERSION` does not change, so no existing journal reposts.

### 8.1 Carried over from the Session 1 review (26 Nov 2026)

The Session 1 `/code-review` (`database-reviewer` + `typescript-reviewer`) found items that belong to
later sessions. Fixed in Session 1 itself, in migration 0049: journals refused outside READ COMMITTED
(the period lock's status read needs a fresh snapshot); every reopen needs a new stamp and a written
reason; account reads in the line and mapping triggers take `FOR SHARE` (no check-then-write against
a concurrent header/deactivation change); a reversal must mirror its target line for line; the TS
validator checks account code and memo like the DB.

**Session 3 (Data Master Akun + Pemetaan akun):**
- A parent account must be a header (today nothing stops a postable account with lines from getting
  children, which would double count in roll-ups), and `accounts_parent_no_cycle` can race: two
  concurrent parent changes can each pass and together form a cycle. Add the header rule and
  serialise parent changes (advisory lock or `FOR UPDATE` on the chain).
- `seed.ts` `seedAccounting` can fail on an edited dev database: `account_mappings_guard_target`
  (BEFORE INSERT) fires before `ON CONFLICT DO NOTHING`, so if the accountant re-maps a default key
  and deactivates its original target, re-seeding raises "must be active". Skip the check when the
  key already exists, or seed with `INSERT ... SELECT ... WHERE NOT EXISTS`.
- `bank_name` / `account_no_last4` are not restricted to cash/bank accounts, and an account code's
  leading digit is not tied to its type (a `6-xxxx` asset is allowed). Enforce both in the account
  editor and, if wanted, a CHECK/trigger.

**Done in Session 3 (migration 0051):** `accounts_guard_tree` replaces `accounts_parent_no_cycle`:
a parent is a header of the same type, a header with sub-accounts stays a header, no cycle, and every
tree change takes one advisory lock and is refused outside READ COMMITTED; an account a mapping points
at cannot become a header; `account_mappings_guard_target` leaves an INSERT of an existing key to
ON CONFLICT (so `seedAccounting` re-runs on an edited database) and checks the target per key family
(expense category/item never 1-15xx [D-14], methods and the Midtrans payout only Kas & Bank 1-11xx/
1-12xx, channels only revenue, supplier payables only liability); CHECKs `accounts_code_type_check`
(leading digit fixes the type) and `accounts_bank_fields_cash_bank_check` (bank fields only on a
postable Kas & Bank account). The same rules live in `packages/accounting/src/mapping-rules.ts` for
the editors' messages.

**Done in Session 6 (migration 0053, D-3):** table `order_manual_payments` (`order_id` PK, `method`
cash/transfer/card, `cash_account_code` → an active, postable Kas & Bank account, `paid_on` = the
Jakarta day the money came in, `recorded_by_staff_user_id`, created/updated stamps; every write
audited `record_manual_payment` / `update_manual_payment` with before/after). Trigger
`order_manual_payments_guard`: a row only for a manual order (no `payment_status`, not
shopee/tiktok) whose stock has left (a `sale` movement, i.e. it reached `to_ship`), the account read
FOR SHARE and active/postable, `order_id` immutable. Written in ONE transaction with the order
(order form, required for a manual channel created as "Siap Kirim") or with the `awaiting_payment →
to_ship` transition ("Siap Kirim" on the order page asks for it; the plain transition is refused on
the server for a manual order); "Isi cara bayar" / "Ubah cara bayar" on the order page fills or
corrects it for older orders (the date is never prefilled there). The picker lists the active Kas &
Bank accounts and preselects the method's `cash.method.*` mapping (card = debit → Bank utama, D-18);
staff may pick another. `packages/accounting/src/rules/manual-orders.ts` holds the pieces S6 uses in
Session 9 (`isManualPaymentOrder`, `suggestedCashAccountFor`, `manualOrderMoneyIn`, which raises the
posting issue `manual_payment_missing` when no row exists: never a default account). Not wired into
the runner yet (S6 lands with S1/S3 in Session 9). After the Session 6 review: rows are never
deleted (trigger `order_manual_payments_guard_delete`), and `accounts_guard_update` refuses to turn
an account payments point at into a header, or to deactivate it while any of those payments has no
active S6 journal (key `('order', <id>, 'collected')`), so S6 never meets an unpostable account.
The view-only order page hides the account name (orders.manage or finance.view_profit only).

**Decided for Session 9 (owner, 26 Nov 2026, after the Session 6 review):**
- **S6 date = the payment date** (`paid_on`), following D-1's deposit pattern: on the paid date Dr the
  chosen Kas/Bank account / Cr 2-1201 Uang muka pelanggan; on the ship date S3 Dr 2-1201 / Cr
  Penjualan (plus HPP). Two journals, the same as a website order (W1, then S3). The §4.1 S6 row says so.
- **Account choice stays free:** any active Kas & Bank account for any method (e.g. cash paid
  straight into the bank); the method's mapping is only the preselection.
- **No lower limit on the payment date** (it is not tied to the order date); only "not after today".
- **No "Belum dicatat" list filter** on the orders page: the posting issue queue
  (`manual_payment_missing`) is where unrecorded orders are found.
- **A record corrected after S6 posted it** (method, account or date): the engine's normal
  reverse + repost (the journal's content hash includes the source date and the account), the
  correction landing in the first open month when the original month is closed [D-23]. No freeze
  of the row; edits stay audited (`update_manual_payment`).
- An order cancelled or returned after payment keeps its record (the money did come in); S6 posts
  it and the cancel/refund rules (S6 cancel line, W3/W4-style refund) must clear 2-1201/2-1202.
- "A manual order reaches to_ship only with a record" is enforced in the admin actions (every
  current `transitionOrderStatus` caller was checked); commerce itself does not enforce it. A new
  caller would leave an order without a record, which S6 then reports as `manual_payment_missing`.

**Done in Session 4 (migration 0052):** manual journals (attachment as `private_files` purpose
`journal_attachment`, only on manual/opening journals; templates Top-up Biteship, penarikan Saldo
Penjual Shopee/TikTok, koreksi refund lewat Midtrans, and closing Ekuitas saldo awal into Modal
pemilik; reversal with a written reason), the opening balance wizard (system proposals confirmed one
by one, typed balances, plug to 3-9001), Tutup buku (close under the month's exclusive lock; months
close in ascending order from January 2027; open posting issues need a written override reason,
stored on `fiscal_periods.close_override_reason`; PPh final rate end warns, never blocks; reopen
needs a written reason; December 2026 never closes) and Neraca saldo with PDF/Excel. The trial month
/ official books rule is §5.4. Not yet: the MDR "still an estimate" close warning (D-8) needs fee work
A's `source` column and lands with Session 11.

**Done in Session 7 (no migration; every account, mapping and guard row already existed):**
- `packages/accounting/src/rules/purchases.ts`, rule `purchase_chain` (version 2): P1 (`goods_receipt_item`,id,
  `received`), P2 (`goods_receipt_item`,<reversal item id>,`reversed`), P3/P4 (`supplier_payment`,id,`paid`/`void`),
  P5 (`purchase`,id,`closed_overpaid`), P6 (`defect_movement`,id,`return_out`; its reversal is keyed on the
  reversal row with the same event so the D-14 trigger still covers it). One purchase document is replayed in
  date order, ties by the record's own timestamp; a negation is never ordered before its original. Events
  dated before the posting start are replayed (so a December payment clears a November receipt's utang)
  but not posted. A receipt item without a stock-ledger value blocks the rest of its document as
  `receipt_value_missing` (never guessed).
- **Session 2 follow-up done:** purchase payments moved from `supplier_payment` v1 to `purchase_chain` v2, so
  every v1 purchase-payment journal is reversed and re-posted with the utang / Uang muka pembelian split.
  Batch payments (R4) stay on `supplier_payment` v1, unchanged (no churn); their over-payment → 1-1601 split
  needs R1 and lands in Session 8.
- **Position rule (owner, 26 Nov 2026, after the Session 7 review; supersedes "exact negation" for P2/P4 and
  the P6 reversal where it would leave a wrong-side balance).** Per purchase document, the net position is
  N = receipt value (accepted + rejected) − returns to the supplier − payments. After EVERY event of the
  chain the document's balance sits on exactly one account: N > 0 → 2-1101 Utang usaha pemasok bahan;
  N < 0 while open → 1-1601 Uang muka pembelian; N < 0 after the close (closed or cancelled) → 1-1402
  Piutang klaim pemasok. Each journal = the event's own side (stock 1-1501/1-1502/1-1506 or Kas/Bank) +
  only the change of those three balances. Neither 2-1101 nor 1-1601 (nor 1-1402) ever ends with a
  wrong-side balance for any document. Examples: a DP voided after a receipt used it → Dr Bank / Cr 1-1601
  (the unused part) + Cr 2-1101 (the used part); a receipt reversed after it was paid → Cr stock / Dr
  2-1101 (back to 0) + Dr 1-1601 (the payment is now an advance); a payment voided after the close → Cr
  1-1402. When no wrong side is at stake, P2, P4 and the P6 reversal come out as the exact negation of
  their original. P5 is the close step itself (1-1601 → 1-1402); a reopen un-posts it and every later event
  is re-derived on the open side. Tests: `packages/accounting/test/purchase-chain.test.ts` ("position
  rule", incl. a running-balance check after every journal) and `purchase-chain-db.test.ts`.
- **P6 (approved deviation, consistent with the position rule):** a return to the supplier lowers N, so it
  clears open utang first and, on goods already paid, becomes Dr 1-1601; the replacement receipt (P1) uses
  that advance and the document nets to its tagihan.
- Rekonsiliasi check 1 shows production consumption as "tidak dijurnal" until Session 8 posts R1 (owner, OK). *Done in Session 8.*
- `rules/raw-materials.ts`, rule `raw_material_adjustment` v1: P7 (`fabric_stock_movement` | `accessory_movement`,
  id, `adjustment`), dated created_at (Jakarta), recount/other → 6-4101, damaged/lost → 6-4102 [D-16]; a colour
  reclassification pair (one fabric, same instant, nets to zero) posts nothing; a legacy manual purchase dated
  on/after the start is the issue `legacy_raw_purchase`.
- Rekonsiliasi page `/accounting/reconciliation` (accounting.view): check 1 (1-1501/1-1502 vs the stock ledgers,
  production consumption, legacy rows and voids of pre-books receipts shown as "not journaled") and check 2
  (per purchase document: app tagihan − paid vs utang − uang muka − piutang klaim + not yet received).
- Ledger-side D-14 guard test: `packages/accounting/test/purchase-chain.test.ts` (every P1-P6 line is on
  1-11xx/1-12xx, 1-14xx, 1-15xx, 1-16xx or 2-11xx, and `purchaseGuardViolations` is empty).

**Done in Session 8 (no migration; every account, mapping and guard row already existed):**
- `packages/accounting/src/rules/production.ts`, rule `production_chain` (version 2), one production batch
  replayed in date order: R1 (`production_batch`,id,`posted`, dated posted_at: Dr 1-1503 = Σ the batch's
  fabric + accessory `production` movements + Σ cost lines / Cr 1-1501, 1-1502 + the service lines as a
  position change per payee), R2 (`goods_receipt_item`,id,`received`; its reversal `reversed`, the
  reversal item's own negated values), R3 (`production_batch`,id,`wip_close`, D-15), R4 (`supplier_payment`,
  id,`paid`/`void`), R5 (`defect_movement`,id,`return_out`, Dr 1-1503 / Cr 1-1506; its reversal keyed on
  the reversal row). A posted batch without fabric consumption rows is the issue `batch_consumption_missing`
  (it blocks the batch's later chain steps); a legacy batch stocked at posting (pre-0025) posted on/after the
  start is `legacy_batch_stock`, and gets no R3.
- **R3** is dated the later of the close and the batch's last receipt or return (so a reversal on a closed
  batch moves R3 after it). `received` → the rest to 5-1201 (either sign); `closed` → the whole rest to
  6-4102 (either sign, D-15 (b): no split of the rounding part). A reopen (a return to the tailor reopens a
  closed batch) makes R3 "none", so the runner reverses it; the next close re-posts. R3 settles the whole
  batch even when R1 was before the start (the official opening carries the pre-cut-over part).
- **R4 on the position rule (the Session 7/8 follow-up):** per payee of the batch, N = the payee's cost
  lines (from R1 on) − its payments; N > 0 → 2-1102 (2-1103 without payee); N < 0 while the batch is in
  production → 1-1601 (e.g. a payment dated before the posting); N < 0 once production ended (R3's step:
  received or closed) → 1-1402, so R3 also moves a left-over advance to the claim, and a reopen moves it
  back. Every R1/R3/R4 journal holds only its step's change; no wrong-side balance (unit test with a running
  balance). Batch payments left `supplier_payment` v1, which now emits nothing and is no longer a default
  source; v2 re-derives every v1 batch-payment journal (reverse + repost). Payees are settled in a fixed order
  (suppliers by id, no payee last), so the lines' order, and the content hash, never follow the database's
  row order. The opening-balance proposal follows the same rule (an over-paid batch that ended before the
  cut-over proposes 1-1402, not 1-1601).
- `rules/inventory.ts`: A1 `finished_goods_adjustment` v1 (`stock_movement`,id,`adjustment`, created_at
  Jakarta, recount/other → 6-4101, damaged/lost → 6-4102, value 0 → nothing, D-16) and A2 `defect_disposal`
  v1 (`defect_movement`,id,`dispose`, occurred_at: Dr 6-4103 / Cr 1-1506; auction proceeds Dr
  `cash.method.cash` (1-1101) / Cr 7-1101, D-7; its reversal keyed on the reversal row, posted only while the
  original is active). Loaders in `production-loaders.ts`.
- Rekonsiliasi: production consumption is journaled now (dated by the batch's posted_at, as R1), so it no
  longer shows as "tidak dijurnal"; new cards for 1-1503 (Σ per-batch WIP from the records; trial month: the
  part of batches posted before 1 Dec is "not journaled"), 1-1504 (vs stock_movements; sales and returns
  "not journaled" until Session 9, legacy at-posting stock, voids of pre-books receipts) and 1-1506 (vs
  defect_movements; voids of pre-books rows); a per-batch list "Barang dalam proses per batch" (the batch's own
  1-1503 journals vs cost − received − rejected + returned, 0 after R3). Tests: `test/production-chain.test.ts`,
  `test/inventory.test.ts`, `apps/admin/src/lib/accounting/session8.test.ts` (Haura beige L, reopen and
  replacement, A1, A2, v1 → v2), e2e `accounting.spec.ts` at 390/1280.

**Done in Session 9 (no migration; every account, mapping and source column already existed):**
- `packages/accounting/src/rules/sales.ts`, rule `sales` (version 1), one order per snapshot (loader
  `sales-loaders.ts`): S1 (`stock_movement`,id,`sale`), S2 (`stock_movement`,id,`return`; after shipping exactly
  when the order ended `returned`), S3/M1 (`order`,id,`recognised`), S4 (`order`,id,`returned`), S6
  (`order`,id,`collected`, dated `paid_on`), W1 (`payment`,id,`paid`), W3 and the manual cancel line
  (`order`,id,`cancelled_paid`), W4 (`payment`,id,`refunded` for the hand-recorded part, Cr `bank.main`;
  `payment`,id,`gateway_refunded` for the rest of `refunded_amount`, Cr 1-1301), W9/W10 (`shipment`,id,
  `charged`/`cancelled`), M2 (`order`,id,`channel_fees`). W2/W5 rule code in `rules/midtrans.ts`, tested against
  fee-work-A/B-shaped fixtures, not in `defaultPostingSources()` until Session 11.
- **S3 HPP = the order's sale movements' exact value**, not Σ qty × `unit_cost` (`unit_cost` is
  `round(value/qty)`, which would leave rupiah in 1-1505).
- **W1 for a payment that arrived after the cancel** credits 2-1202 directly (the plan's "W1 then W3" for that
  payment in one journal, same balances); W3 holds only the payments paid by the cancel, less refunds made before
  it. **W4's debit** is 2-1202 once the order was cancelled/returned before the refund, else 2-1201 (a refunded
  duplicate payment of an order going ahead). A chargeback has no amount in the data: issue `payment_chargeback`.
- **Gateway refund date:** the first signature-valid `payment_notifications` row with status `refund` /
  `partial_refund` (stable); only without one `payments.updated_at`, and then the journal keeps its first date
  while its lines are unchanged (runner flag `dateFollowsActive`), since every later status read bumps
  `updated_at`.
- **W9 uses up the buyer's titipan in full** at booking: Dr 2-1203 `shipping_amount` · Dr 6-1302 subsidy ·
  Dr/Cr 6-1301 `cost − shipping − subsidy` (D-10: the difference between the real and the checkout tariff is Beban
  ongkos kirim, either sign; check 3c expects 0). The §4.2 "(at most …)" caps are not applied: with them a courier
  cheaper than the quote could never credit 6-1301. **Decided (owner, 27 Nov 2026): approved as built**, no caps; §4.2 W9 updated.
- **Held events:** S2 after shipping, S4 and M2 wait behind S3 while S3 is a posting issue (today every marketplace
  order shipped on/after the start: `marketplace_ship_date_missing`, Session 5 is blocked); the manual cancel waits
  behind S6 while it is `manual_payment_missing`. New runner flag `requiresActiveJournalAcrossBooks`: unlike a
  void, a held real event follows its original across the cut-over. Keys that can lose their event (W3, both W4
  keys) are always emitted, "none" when empty, so a stale journal is reversed.
- Rekonsiliasi: section "Penjualan" with per-order checks 1 (1-1505), 3 (2-1201) and 3c (2-1203) (records via
  `sales-balances.ts` vs the journal lines carrying the order id, within the set of books; orders with events
  before the books are "review"), check 3b (1-1603 vs the dashboard balance typed in the filter, never stored).
  1-1504 no longer lists sales as "not journaled"; it lists marketplace returns held behind a missing ship date.
- Tests: `packages/accounting/test/sales.test.ts`, `test/runner-session9.test.ts`,
  `apps/admin/src/lib/accounting/session9.test.ts` (through createOrder, Session 6's payment record,
  transitionOrderStatus, applyPaymentStatus, cancelCheckoutOrderByStaff, recordManualRefund), e2e
  `accounting.spec.ts` at 390/1280.

**Done in Session 10 (no migration; reads only):**
- Pages `/accounting/balance-sheet` (Neraca), `/accounting/income-statement` (Laba rugi) and `/accounting/cash-flow`
  (Arus kas), accounting.view, each with PDF and Excel (`…/export`, audited as `balance_sheet` / `income_statement` /
  `cash_flow_statement` `download` in Log Aktivitas, like Neraca saldo). One pure layout module
  (`apps/admin/src/lib/accounting/statement-layout.ts`) builds the rows the page, the PDF and the Excel file all show;
  sections follow the account TYPE and the header tree, never hard-coded codes.
- **Books split (§5.4):** every figure is summed within one set of books, by `entry_date` (so the statements tie out
  to Neraca saldo and Buku besar). Laba rugi and the Arus kas movements leave out the opening journal (and a reversal
  of it); the Neraca and the Arus kas opening cash include it. A range crossing the cut-over starts at 1 Jan 2027.
  Laba rugi also leaves out `kind = 'closing'` journals (Session 11's year-end close), so the Neraca's "Laba (rugi)
  berjalan" (Σ of the P&L accounts not yet closed, shown in equity so the statement balances) and Laba rugi stay
  consistent once closing exists.
- **Neraca:** aset (header tree), kewajiban jangka pendek / jangka panjang (the chart's 2-1 / 2-2 convention), ekuitas
  + laba berjalan; comparative = the end of the previous month in the same books; January 2027 compares to the
  official opening balance (the opening journal only), the trial month has no comparative.
- **Laba rugi:** layout as §6 (HPP = the `cogs` accounts only, so 6-4000 Beban persediaan is beban usaha, D-7/D-16;
  penjualan bersih = Penjualan − 4-1201 − 4-1301, after vouchers, no ongkir, D-4/D-6). Column options: jumlah saja,
  per bulan, per saluran (by `journal_lines.channel_id`; lines without one in "Tanpa saluran").
- **Arus kas (direct):** per journal touching a `cash_flow_group = 'cash'` account (Kas tunai and Bank only, after
  migration 0054 below), the cash moved is classified by its
  other lines' groups; transfers between cash accounts and journals without a cash line are no cash flow. Within one
  journal, two non-cash lines of the same group that exactly offset (S3's HPP pair riding with the sale) are dropped from
  the per-account detail only (group totals unchanged; sales/contra/other-income lines are never netted).
- **Rekonsiliasi check 4** (`pnl-reconciliation.ts`, `pnl-reconciliation-rules.ts`): the ledger's Laba rugi for the
  month of the page's date vs the management P&L built from the same `revenue-sql.ts` fragments as Ringkasan/Biaya (test:
  equal to `getExpenseSummary().net`). Every P&L account is in exactly one component; per component, per order or per
  expense: only in management (timing, not posted, before the books), only in the ledger, different amount (refunds,
  returns, courier vs quote, HPP rounding), and ledger lines without a key (manual journals, accruals). The lines add up
  to the difference exactly. Components the management P&L lacks (5-1201, MDR, 6-4000, depreciation, 7/8, PPh) are shown
  with their reason.
- **Rekonsiliasi check 5** (`checkPostingCompleteness` in `@ammari/accounting/runner`): a read-only dry run of the runner
  over every source for events dated from the segment start to the page's date: posted / explained by an open issue /
  held behind its original / gap (missing, outdated, stale, issue not recorded) plus orphans (active system journals no
  rule emits). After a posting run there are no gaps.
- After the Session 10 review: check 5 counts a missing/outdated journal as explained only by a `posting_failed` issue
  (any other open issue on the key is stale until the next run, so it is a gap); check 4 keeps 6-1301 Beban ongkos kirim
  (courier vs quote, return ongkir) as its own component, not part of "subsidi ongkir website" (the management P&L has no
  such figure, so it is never shown as a timing difference); "per bulan" shows at most 12 months (a longer range starts 11
  months before its last month, with a note); a too-wide amount in the PDF shrinks to fit its column. Open for fee work A:
  `orderPlatformFeeSql` sums every `order_channel_fees` row, so once `payment_gateway_fee` rows exist check 4 will show the
  MDR as a management platform fee against a ledger-only 6-1203 (net 0, wrong line); fix in that feature.
- **Migration 0054 (owner + accountant, 27 Nov 2026): receivables are not cash.** 1-1301 Piutang Midtrans, 1-1302/1-1303
  Saldo Penjual Shopee/TikTok and 1-1305 Saldo marketplace belum dipilah move from `cash_flow_group = 'cash'` to
  `operating`; cash is Kas tunai and the bank accounts only. 0049 (already deployed) is not edited: 0054 updates each row in
  place only while it still holds the seeded `cash`, so an accountant's own edit is kept; data only, backward compatible.
  The seed constants (`packages/db/src/accounting/chart-of-accounts.ts`) hold the new group, and
  `CASH_FLOW_GROUP_BEFORE_0054` records 0049's values for its migration test. Effect: a marketplace or Midtrans sale is
  cash in only at the withdrawal / payout (M3, W5), on the operating line of the receivable it clears; a sale and its
  fees on Saldo Penjual move no cash. Test: `packages/db/test/migration-0054.test.ts`.
- Tests: `statement-layout.test.ts`, `pnl-reconciliation-rules.test.ts`, `session10.test.ts` (Neraca balances and = Neraca
  saldo; laba rugi = movement of the unclosed result and of equity net of capital/drawings; trial month and opening
  journal; per month/channel; Arus kas closing = cash accounts in Neraca saldo; check 4 through the real order/payment
  write paths), `packages/accounting/test/completeness.test.ts`, export route tests, e2e `accounting-statements.spec.ts`
  at 390/1280.

**Done in Session 11 (migration 0055, D-19, D-20, §5.7):**
- **Migration 0055** (additive): `fixed_asset_groups` (Kelompok 1 = 48, Kelompok 2 = 96 months, a setting), `fixed_asset_settings`
  (one row, capitalisation threshold Rp1.000.000), `fixed_assets` (the register: group, life copied from the group when saved,
  acquisition date, cost > 0, asset account 1-2xxx, its Akumulasi penyusutan 1-2xxx, funding account Kas & Bank or a liability or
  NULL = "already in the books", disposal date/proceeds/cash account, void with a written reason). Rows are never deleted; a voided
  asset is final (trigger); a group's code is immutable. Mapping `fixed_asset.disposal_result` → 8-1102 (inserted only while 8-1102
  is postable). Reference rows also in `seed.ts` (`seedFixedAssets`, skipped on a database older than 0055).
- `packages/accounting/src/rules/fixed-assets.ts`, rule `fixed_asset` v1, in `defaultPostingSources()`: `acquired` (Dr asset / Cr
  funding, none without a funding account or before the posting start), `dep:YYYY-MM` (journal **kind `depreciation`**, dated the
  month's last day, Dr 6-2401 / Cr the accumulated account; floor(cost / life), the last month absorbs the rounding; posted once the
  month has started; months before the posting start are in the opening balance), `disposed` (Dr Kas & Bank proceeds, Dr
  accumulated = the depreciation of the months BEFORE the disposal month, Cr cost, rest to `fixed_asset.disposal_result`). Every key
  of the life plus every month from the posting start to the current month is emitted, so an edit (date, cost, life), a disposal
  or a void reverses what is stale; corrections into a closed month land in the first open month (D-23). The runner now treats
  `system` and `depreciation` as its own kinds (`ENGINE_ENTRY_KINDS`).
- Register UI `/accounting/fixed-assets` (list, CardList + table), `/new`, `/[id]` (edit while not disposed, "Lepas aset",
  "Batalkan aset"), `/settings` (group months, threshold); accounting.view reads, accounting.manage writes; every write audited
  (`fixed_asset` create/update/dispose/void, `fixed_asset_group` update, `fixed_asset_settings` update). The threshold refuses an
  asset below it ("catat sebagai biaya biasa"); a group edit applies to assets saved (or moved to that group) afterwards only.
- **PPh final accrual at month close** (`packages/accounting/src/period-close.ts` pure, `apps/admin/src/lib/accounting/
  period-close-postings.ts`): closing an official month, under its exclusive lock and before `status = closed`, posts
  (`tax`,`pph_final`,`YYYY-MM`), kind system, dated the month's last day, by the closing staff member. Base = Σ credit − debit on
  the revenue + contra-revenue accounts in the official books (opening/closing journals left out); taxable = max(0, YTD − exemption)
  − max(0, YTD before − exemption); amount = taxable × rate_bps / 10000 toward zero (BigInt). The `tax_settings` row in force for
  the month gives rate/exemption/end date. No row, a rate ending before the month's last day, or a company taxpayer → nothing
  posted, a warning (never a guess). Tutup buku shows the proposal before closing. A re-close after a reopen keeps an identical
  journal, else reverses it (in the month) and posts the new one.
  **PPh final is never negative (owner, 27 Nov 2026):** accrual(m) = max(0, taxable(m) × rate_bps / 10000), rounded down per
  month (matches the monthly setoran). A month whose net sales are negative books nothing (no journal) and never reverses or
  reduces an earlier month's accrual. **Effect on the exemption:** the exemption is measured on the net YTD base, returns
  included, and taxable(m) = max(0, YTD(m) − exemption) − max(0, YTD(m−1) − exemption) is unchanged. So a negative month lowers
  YTD, and the exemption headroom it frees (up to the amount by which YTD falls back below the exemption) is used again by the
  next months' sales before they are taxed. Example, exemption 500: January YTD 600 → 100 taxed; February −200 → YTD 400,
  accrual 0 (January's stays); March +150 → YTD 550, taxable = 50 − 0 = 50; April +1.000 → all 1.000 taxed. While YTD stays above
  the exemption, a negative month simply books 0 and the next months' sales are taxed in full.
- **Year-end closing** (§5.7): closing December of an official year also posts (`year_close`,`YYYY`,`closing`), kind `closing`,
  dated 31 December: every P&L account's year balance → 3-2001 Saldo laba, Prive → 3-1001 Modal pemilik. Re-derived the same way on a
  re-close. Laba rugi already leaves `closing` journals out (Session 10).
- Check 5 does not list the close's own PPh journals as orphans (`PERIOD_CLOSE_SOURCE_TYPES`).
- After the Session 11 review: a close of an official month is **refused while check 5 shows gaps** for events dated from
  1 Jan 2027 through the month's end ("Jalankan Posting sekarang dulu"), so the PPh base and the year-end closing never miss a
  journal the runner has not posted yet (e.g. December's depreciation); the capitalisation threshold is checked on create and
  when the cost changes, not on every edit. Owner answers (27 Nov 2026): no depreciation in the disposal month (approved); the accrual is rounded per
  month, matching the monthly setoran (approved); a rate ending mid-month proposes nothing for that month (approved); a group's
  lifetime edit applies only to assets saved or moved to it afterwards (approved); PPh final is never negative (changed, above).
- **W2/W5 and check 3a stay OFF; the MDR "still an estimate" close warning stays dormant (D-8).** Fee work A/B is not built: no
  `payment_gateway_fee` component in `CHANNEL_FEE_COMPONENTS` (the `source` column on `order_channel_fees` exists since 0061, TikTok T7), and nothing writes
  `order_settlements`. Turn them on (add `mdrRule`/`midtransSettlementRule` loaders to `defaultPostingSources`, the warning to
  `periodWarnings`) in the fee-work feature.
- PT conversion (D-24) is not in this session's scope (§5.8: multi-entity out of scope).
- Tests: `packages/accounting/test/fixed-assets.test.ts`, `period-close.test.ts`, `apps/admin/src/lib/accounting/fixed-asset-input.test.ts`,
  `session11.test.ts` (runner idempotent, edit after close → first open month, void, disposal, pre-books asset, PPh crossing the
  exemption, rate end, rate change, re-close, year close zeroes P&L), `packages/db/test/migration-0055.test.ts`, e2e
  `accounting-fixed-assets.spec.ts` at 390/1280.

**Done in Session 12 (migration 0056; cron, run lock, constraint hardening, app database role, docs):**
- **Run-level posting lock** (`runPostingExclusive` in `packages/accounting/src/runner.ts`): the cron route and
  "Posting sekarang" each take one transaction-scoped try-lock (`hashtext('ammari.posting_run'), 0`), held by an idle
  transaction on its own connection for the whole run (the idiom of commerce's `withExclusiveRun`); a second caller is
  told at once, never waits. The button then says "Posting sedang berjalan (otomatis atau dari staf lain) ...". The
  per-key locks stay the backstop (two runs that bypass the run lock still post a key once; tested).
- **Stuck "running" runs:** while holding the run lock, a run still `running` more than 10 minutes after it started
  (`STALE_POSTING_RUN_MINUTES`) belongs to a dead process (or a pre-Session-12 release mid-deploy, which is what the
  margin covers) and is closed as `failed` with `interrupted: the process stopped before the run finished`.
- **Posting cron** `POST /api/internal/accounting/posting` in apps/web (the repo's cron pattern: `authorizeCronRequest`
  (secret, refused through Caddy/Cloudflare), the shared cron lock `withExclusiveRun(..., "accountingPosting")` so it
  never overlaps the sweep or the email pass, then the posting run lock; `[accounting]` log lines, no error text in the
  answer). 200 with the counts, 200 `{ skipped: "running" | "posting_in_progress" }` when a lock is busy, 500 when a key
  failed to post (`posting_failed`) or the run failed. Ordinary posting issues are 200 (the bookkeeper's queue, not a
  cron failure). `deploy/cron/cron.sh` (= `deploy-prod/cron/cron.sh`) calls it every 15 minutes (`POSTING_EVERY=900`,
  max 240 s), retries a failed call on the next 5-minute tick and logs `ALERT` after 3 failures in a row. The plan's
  "nightly + every 15 minutes" is one job: every run re-checks every source, so a separate nightly run adds nothing.
  apps/web gains the `@ammari/accounting` dependency (server-only code; it reads sources and writes journal tables only,
  no existing write path changes).
- **Posting status** (`apps/admin/src/lib/accounting/posting-status.ts`) on Jurnal umum and Rekonsiliasi: the last
  run (otomatis/manual, running/failed) in the description, and a warning when the last run failed or no automatic run
  succeeded within the hour ("Posting otomatis belum berhasil sejak ..."), so a broken cron is visible to the bookkeeper.
- **Constraint hardening, migration 0056** (two CHECKs on `journal_entries`, nothing else):
  `journal_entries_entry_no_month_check` (the number's `YYYYMM` = the entry_date's month; `nextEntryNo` always numbered
  that way) and `journal_entries_entry_date_floor_check` (`entry_date >= 2026-12-01`, the trial month; the app already
  refused earlier dates). Validated on ADD: a database holding a violating row refuses the migration (the deploy then
  stops before any app container; runbook R0 has the read-only pre-check). Backward compatible: the previous release
  writes only rows that pass. The trial-month CHECK on `fiscal_periods` keeps its hard-coded `2026-12-01` (fine while
  D-22 stands). Applied to the local dev database only.
- **TRUNCATE: a separate app database role** (`packages/db/src/ops/app-role.ts`). Re-checked while writing the runbook:
  a `REVOKE TRUNCATE` alone would do nothing today, because admin, web and the migrator all connect with ONE
  `DATABASE_URL`, the role that owns every table (on prod the Postgres container's superuser); an owner (and a
  superuser) always keeps TRUNCATE and can disable triggers. So the apps move to their own role (`ammari_app`: LOGIN, no
  superuser/createdb/createrole/bypassrls, never a member of the owner, SELECT/INSERT/UPDATE/DELETE on every table in
  `public` and nothing else, default privileges so tables of later migrations get the same), and only the migrator keeps
  the owner, through a new `env/migrator.env`. `setup-app-role.ts` (idempotent, run by hand, runbook R1) and
  `check-app-role.ts` (the verification) run from the migrator image. The check covers EVERY table in `public` (no
  TRUNCATE, TRIGGER or REFERENCES; plain DML present, so a migration that forgot the grants fails the deploy instead of
  breaking the app), the role's attributes, owner membership (MEMBER, so a NOINHERIT member that could `SET ROLE` is
  caught) and that the plan's protected tables still exist (`PROTECTED_TABLES`: the plan's list re-checked against the
  schema plus `fixed_asset_*`, `order_manual_payments`, `payments`, `payment_notifications`, `order_channel_fees`,
  `order_settlements`). `deploy/remote-deploy.sh` and `deploy-prod/remote-deploy.sh` run migrations with
  `env/migrator.env` when it exists (else `env/admin.env`, as before), then the check: it **fails the deploy** once
  `env/migrator.env` has `APP_DB_ROLE`, and only **warns** before the split (so nothing breaks until R1 is done); an
  older migrator image (a rollback) has no check script and is skipped with a note. `deploy-prod/upload-prod-env.sh`
  uploads `prod-migrator.env` when it exists.
- **Year-end close lock ordering:** done in Session 4/11 and re-checked: one month per transaction, the previous month's
  lock then this month's exclusive lock (ascending), the PPh and year-end closing journals posted before
  `status = 'closed'`, reopen only newest first. Recorded in `apps/admin/src/lib/accounting/periods.ts`; nothing to run.
- **Data-only restore notes, index suggestions:** runbook R4 and R5 (not built: indexes wait for real volume).
- **Test hygiene:** the 23 copies of `migrationsUpTo` (and their local `migrationsFolder`) in `migration-00xx.test.ts`
  now import `packages/db/test/scratch-database.ts`'s (also exported as `@ammari/db/test-scratch`);
  `accounting-ledger.test.ts` migrates from `migrationsFolder` directly, numbers its fixture entries by their own month
  (0056), and "nothing is left behind by a refused entry" refuses its own entry and looks for its number (no longer
  vacuous with `-t`); `migration-0048.test.ts`'s comment states the condition it relies on.
- **After the Session 12 review** (`typescript-reviewer`, `database-reviewer`, `security-reviewer`; no critical/high):
  fixed: `setup-app-role.ts` sends only a SCRAM-SHA-256 verifier (`scramSha256Verifier`), never the plaintext password,
  so a server log of DDL cannot capture it; the check also logs in with admin's and web's own `DATABASE_URL` (passed by
  the deploy through the environment, never argv) and fails unless `current_user` is the app role, so "role fine, apps
  still on the owner" cannot pass; membership in ANY role is refused (a NOINHERIT member reaches another role's rights
  with SET ROLE, e.g. `pg_write_all_data`) and setup removes them; views, materialized views and foreign tables are
  checked for TRUNCATE/TRIGGER/REFERENCES; on prod's `--skip-migrate` rollback path a failed check only warns (a rollback
  must stay possible); a run closed as stale while still working (its lock connection dropped) records its real outcome
  at the end instead of failing on the CHECK; runbook R1 writes the URL file under `umask 077`, asserts the rewrite and
  logs in with the new URL (pre-flight) before any app uses it, and the R1 rollback also removes `APP_DB_ROLE`.
  Not changed, by design: the posting cron runs inside the shared cron lock, so while a run lasts the sweep and the
  email pass answer `skipped: running` (seconds at today's volume; the plain reason for the shared lock is the web
  pool's 5 connections: cron work holds at most the two idle lock transactions plus the run's own queries); revisit
  (posting lock only, or a dedicated small pool) if a run ever takes minutes. A key failing every run answers 500, so the
  cron retries every 5 minutes and alerts after 3 (intended). Dev's deploy has no rollback flag, so a failed check there
  stops a dev rollback too (dev only; fix the grant or remove `APP_DB_ROLE`). The check covers schema `public` only (the
  apps use nothing else).
- Docs: SPEC §5.4 (accounting summary), docs/deploy.md internal cron section, this runbook (§12) and the go-live
  checklist (§13).
- Tests: `packages/accounting/test/posting-run-lock.test.ts` (scratch database, real commits: second run skipped at
  once, lock released after a failure, stale runs closed and a recent one kept, per-key backstop),
  `apps/web/src/app/api/internal/accounting/posting/route.test.ts` (auth gate, counts, 500 on failed keys or a throw,
  skipped under either lock), `apps/admin/src/app/(shell)/accounting/actions.test.ts` (busy message),
  `apps/admin/src/lib/accounting/posting-status.test.ts`, `packages/db/test/migration-0056.test.ts`,
  `packages/db/test/app-role.test.ts` (a real login as the app role: reads/writes, TRUNCATE refused on every protected
  table, no DISABLE TRIGGER, no CREATE TABLE, later tables granted, every check failure, setup repairs), e2e
  `accounting.spec.ts` (posting status at 390/1280).

---

## 9. Risks

- **The two small features slip past 1 Jan 2027** (Session 5 [D-2], Session 6 [D-3]): nothing is guessed —
  marketplace orders without a real ship date and manual orders without a payment record become
  posting issues. Recoverable: re-uploading the marketplace files fills the dates; the "isi metode
  bayar" action fills manual orders. January cannot close (by 10 Feb) until they are cleared.
- **Shopee returns keep the import time** ([D-2] covers ship/complete dates only; TikTok's S4 is dated by
  `marketplace_returned_at` since tiktok-shop-integration.md T8): S4 for a Shopee return is dated when the
  return is imported; if that month is closed the return
  lands in the first open month. Acceptable under [D-23]. **Decided Q5 (28 Nov 2026):** S4 uses the refund date from Penghasilan
  Saya once 7e imports it. The import time is only the fallback while no refund row has been imported.
- **Shopee fees arrive late** (no fee columns in the order export; Session 5 option A): orders shipped
  late in a month whose income is imported after the close get their fees in the first open month
  [D-5, D-23]. The close warning lists them, and the accountant may accrue by manual journal.
- **Every Shopee order is held until the seller SKUs are filled** ("Nomor Referensi SKU" is empty on
  the shop's listings, marketplace-import.md §19.6). The owner fills them next week, before launch
  (Q6). If that slips, Shopee revenue and stock are missing until a re-export after the fix.
- **PPh final rate end** ([D-20]): with the original PP 55/2022 limit, the 0,5% rate for an NPWP
  registered in 2020 ends with tax year 2026, i.e. **before the first official month**. Until the
  accountant confirms the PP 55 revision and updates `rate_valid_until`, the system proposes no
  accrual for 2027 and warns at every close. If the extension does not materialise, regular income
  tax applies and this accrual design must be revisited.
- **Mutable sources** (marketplace fees/vouchers, mappings): handled by reverse + repost in open
  periods; closed periods get corrections in the next open period, never rewritten.
- **Data the system does not have** (marketplace withdrawals, refunds that went through Midtrans,
  Biteship top-ups, Midtrans payouts until fee work B) needs manual journals; the Rekonsiliasi page
  makes the open balances (1-1305, 1-1302/1-1303, 2-1203, 1-1301, 1-1603) visible so they cannot be
  forgotten.
- **Order of features:** fee work A adds a component and a `source` column to `order_channel_fees`.
  The ledger must read only rows it understands (M2 excludes `payment_gateway_fee`; W2 reads only
  it), and the management P&L's "Laba setelah biaya platform" will start including the MDR unless
  fee work A decides otherwise — flagged for that plan, not changed here.
- **Performance:** source volume is small; the runner works per period and uses existing indexes
  (`stock_movements_ref_idx`, `orders_*`); journals get `(entry_date)`, `(account_code, entry_date)`
  and `(source_type, source_id)` indexes.
- **PT conversion** [D-24]: decided as close-and-reopen (§5.8). The PT's accounting standard
  (SAK EMKM or SAK EP) is chosen when the PT is formed; multi-entity is out of scope.

---

## 10. Owner answers (2026-11-26)

1. **Midtrans fee "A+B"** — in the owner's backlog (chosen 9 Nov), built after launch: A = estimated
   MDR per payment from a Settings fee table (percent + flat + PPN, `effective_from`) as an
   `order_channel_fees` row `payment_gateway_fee`, `source = estimate`, on `gross_amount` incl.
   buyer ongkir, idempotent, backfilled; B = Midtrans CSV import on `/import` overwriting with the
   actual fee (`source = actual`) and filling `order_settlements`. MDR is not returned on refunds.
   → §1.2, W2, W4, W5, checks 3a, Sessions 9/11.
2. **Biteship** — balance topped up in advance, courier cost deducted per booking, separate
   monthly Grow subscription (≈ Rp149.000); past top-ups recorded nowhere. → §1.10, 1-1603,
   W9–W11, §5.4–5.5, check 3b.
3. **No resellers, no credit sales; manual orders are always paid before shipping.** → no trade
   receivable (1-1401 removed), S3/S6, [D-3].
4. **Final policy decisions D-1..D-25** (owner + accountant, 26 Nov 2026) → the whole plan;
   notably: two small features, Session 5 (real marketplace dates) and Session 6 (manual-order payment); 1-1304
   Kliring penerimaan penjualan manual, 2-1301 Utang kartu kredit and 4-1401 Pendapatan ongkos
   kirim removed; Selisih persediaan and Kerusakan & kehilangan persediaan moved from HPP to beban
   usaha (6-4101/6-4102); D-7 revision: Barang cacat dilepas also moved to beban usaha (6-4103); R3 split automatically; `tax_settings` added.

Remaining items for the accountant (not open decisions): confirm the PP 55 revision and enter the
new `rate_valid_until` [D-20]; review the initial expense-category mapping once [D-25]; choose the
PT's accounting standard when the PT is formed [D-24].

---

## 11. Decisions — index (all DECIDED, owner + accountant, 26 Nov 2026)

The full text (the rule, plus the rejected alternative), in Indonesian for the accountant, is
**[accounting-decisions.md](accounting-decisions.md)**; its numbers are the [D-n] cited above.

| # | Topic | Decided rule | Where |
|---|---|---|---|
| D-1 | Revenue recognition | Revenue + COGS at handover to the courier (shipped) | S3, W1, W5, M1, M2 |
| D-2 | Date of imported marketplace orders | Real ship/complete dates from the export file (feature, Session 5); no "by the 3rd" rule | M1, Session 5 |
| D-3 | Money from manual orders | Staff picks method + destination account per order (feature, Session 6); no credit sales | rule S6, Session 6 |
| D-4 | Vouchers | Sales discount 4-1201 (contra revenue) | S3, W7 |
| D-5 | Marketplace fees | Selling expense on the sale date; re-upload differences to the first open month | M2, rule S5 |
| D-6 | Buyer-paid ongkir and subsidies | Titipan ongkir 2-1203 (liability); web + marketplace seller subsidies are selling expense | S3, W6, W9, M2 |
| D-7 | Returns, defects, own use | Retur penjualan + HPP back at original cost; refunded ongkir → 6-1301; defects released → 6-4103 (operating expense, revised 26 Nov); auction proceeds → 7-1101; own use → Prive at cost | S2, S4, A2, §5.1 |
| D-8 | Midtrans MDR | Estimated at payment (per method: % + fixed + PPN on total incl. shipping), replaced by actual; close warns on estimates; not refunded | W2, W4, W5, §7 |
| D-9 | Bank side of manual refunds | Bank utama; accountant reclasses if via Midtrans | W4 |
| D-10 | Biteship | Top-up = asset 1-1603 (manual journal); bookings draw it down; cancel restores; Grow → 6-2501; opening from dashboard | W9–W11, §5.4–5.5 |
| D-11 | Seller balances | Saldo Penjual Shopee/TikTok; withdrawals by manual journal; unallocated spend → 1-1305 | M3, M4 |
| D-12 | Inventory method | Moving average (existing costing) | §1.8 |
| D-13 | Supplier debt | At goods receipt; DP = 1-1601, auto-applied; overpaid close → 1-1402 | P1–P6 |
| D-14 | Separately recorded material shipping | Expense 6-3101; raw-material purchases always inventory (guard) | §3 guard, §4.8, Session 7 |
| D-15 | Production leftovers | Automatic: short-closed batch rest → 6-4102; normal rounding residue → 5-1201 | R3 |
| D-16 | Count variance, damage, loss | Operating expenses 6-4101 / 6-4102, not COGS | A1, P7, R3, §3 |
| D-17 | Cash and bank accounts | One bank: Tunai → 1-1101, Transfer → 1-1201; D-3 list = these two | E1, P3, rule S6, §5.2 |
| D-18 | "Kartu" | Debit card → 1-1201; credit-card option only if ever needed (backlog) | E1, §3 |
| D-19 | Depreciation | Straight line from acquisition month; Group 1 = 4 y, Group 2 = 8 y; zero salvage; Rp1.000.000 threshold | §5.3, Session 11 |
| D-20 | PPh final 0,5% | Monthly accrual; wife as individual taxpayer (NPWP 2020); Rp500 juta exemption; base = net sales excl. ongkir, marketplace gross; rate/exemption/end date in `tax_settings` | §2.1, §5.6, Session 11 |
| D-21 | PPN | Not PKP; no VAT accounts; VAT paid is cost | W2, §3 |
| D-22 | Cut-over | 1 Jan 2027; opening balances as of 31 Dec 2026; Dec 2026 trial month (posted, not locked) | §5.4, §7, §8 |
| D-23 | Month close | By the 10th; late corrections to the first open month; reopen only owner/accountant with written reason | §2, §7 |
| D-24 | Becoming a PT | Close the sole-proprietor books; open the PT with its own opening balances | §5.8 |
| D-25 | Expense category mapping | One account per category (item override); new categories must be mapped (warning); liability payments map to the liability | §3, E1 |

---

## 12. Runbook (Session 12): for the owner to run by hand

Nothing here was run by an agent: no agent session connects to the dev or prod servers. Order: **dev first, then
prod**, each step on dev before the same step on prod. `<sha>` is the deployed commit (`cat .env` / the deploy log).
Every command prints no secret; never paste a password or a `DATABASE_URL` into a terminal or a chat.

### R0. Deploy Session 12 (migration 0056)

1. **Pre-check 0056** (read-only, prod; on dev the migration itself is the check). Prod, in `/opt/ammari-prod`:
   `docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) filter (where substr(entry_no,4,6) <> (extract(year from entry_date)::int*100+extract(month from entry_date)::int)::text), count(*) filter (where entry_date < date '"'"'2026-12-01'"'"') from journal_entries"'`
   Expect `0|0` (every journal so far was numbered by `nextEntryNo` and dated from 1 Dec 2026). If 0056 ever meets a
   violating row (dev or prod), the migrator fails with `journal_entries_entry_no_month_check` or
   `journal_entries_entry_date_floor_check`, nothing is applied and the deploy stops before touching any app container:
   send me the counts (not the rows).
2. Deploy as usual (dev: push to `dev`; prod: fast-forward `main`, run "Deploy (prod)"). The log shows
   `==> WARNING: env/migrator.env with APP_DB_ROLE is missing ...` until R1 is done: expected, the deploy goes on.
3. The cron container is recreated by every deploy and picks up the new `cron.sh`; R2 checks it.

### R1. The apps' own database role (TRUNCATE revoked)

Why: row-level triggers never fire on `TRUNCATE`, so `TRUNCATE journal_lines` would bypass every append-only guard.
The apps today connect as the role that owns the tables (prod: the Postgres container superuser), which can always
TRUNCATE and disable triggers. After R1 the apps connect as `ammari_app` (no TRUNCATE, owns nothing) and only the
migrator connects as the owner, through `env/migrator.env`. Takes about 15 minutes per server; the apps restart once.

**Dev: not done for now (owner, 27 Nov 2026).** R1 is prod-only; dev keeps the owner URL and its deploys keep printing
the `env/migrator.env is missing` warning. The dev steps below stay for later.

**Dev** (as `deploy`, in `/opt/ammari`; the database is the managed Sumopod instance):

1. `(umask 077 && grep '^DATABASE_URL=' env/admin.env > env/migrator.env && echo 'APP_DB_ROLE=ammari_app' >> env/migrator.env)`
   (the owner's URL, copied, never printed).
2. `(umask 077 && openssl rand -hex 32 > /tmp/app-db-pw)`
3. `APP_DB_PASSWORD="$(cat /tmp/app-db-pw)" docker run --rm --env-file env/migrator.env -e APP_DB_PASSWORD ghcr.io/tangguhriyadi/ammari-migrator:<sha> node_modules/.bin/tsx src/ops/setup-app-role.ts`
   Expect `setup-app-role: PASS ammari_app is ready`. `failed: permission denied to create role` means the managed
   instance does not let this user create roles: `rm env/migrator.env /tmp/app-db-pw`, stop here for dev (the deploy keeps
   warning, nothing breaks) and tell me; prod (step list below) does not depend on dev.
4. Build the app role's URL (owner-only file, value never on a command line or a terminal):
   `(umask 077 && PW="$(cat /tmp/app-db-pw)" awk -F= '/^DATABASE_URL=/{ sub(/^DATABASE_URL=/, ""); sub(/^postgres(ql)?:\/\/[^@]*@/, "postgresql://ammari_app:" ENVIRON["PW"] "@"); print; exit }' env/migrator.env > /tmp/app-db-url)`, then
   `grep -q '^postgresql://ammari_app:' /tmp/app-db-url && echo REWRITTEN || echo STOP` must say `REWRITTEN` (STOP: the
   URL has an unexpected shape; `rm /tmp/app-db-url /tmp/app-db-pw` and tell me, nothing has changed yet).
5. **Pre-flight login** with the new URL, before any app uses it:
   `APP_DATABASE_URL_ADMIN="$(cat /tmp/app-db-url)" docker run --rm --env-file env/migrator.env -e APP_DATABASE_URL_ADMIN ghcr.io/tangguhriyadi/ammari-migrator:<sha> node_modules/.bin/tsx src/ops/check-app-role.ts`
   must print `check-app-role: PASS ... admin log in as it`. A `cannot log in` line (e.g. the provider wants a different
   username form): stop, `rm /tmp/app-db-url /tmp/app-db-pw`, tell me the line; the apps are untouched.
6. Point admin and web at it: `./set-env-var.sh env/admin.env DATABASE_URL < /tmp/app-db-url` and
   `./set-env-var.sh env/web.env DATABASE_URL < /tmp/app-db-url`, then `docker compose up -d --force-recreate admin web`
   (env is read only at start) and `rm /tmp/app-db-pw /tmp/app-db-url` (also if any step fails).
7. Check: `APP_DATABASE_URL_ADMIN="$(sed -n 's/^DATABASE_URL=//p' env/admin.env)" APP_DATABASE_URL_WEB="$(sed -n 's/^DATABASE_URL=//p' env/web.env)" docker run --rm --env-file env/migrator.env -e APP_DATABASE_URL_ADMIN -e APP_DATABASE_URL_WEB ghcr.io/tangguhriyadi/ammari-migrator:<sha> node_modules/.bin/tsx src/ops/check-app-role.ts`
   prints `check-app-role: PASS ... admin and web log in as it` (the deploy runs exactly this from now on); open admin
   (Pesanan, Akuntansi > Jurnal umum, "Posting sekarang") and the storefront; `docker compose logs --tail 50 web admin`
   has no `permission denied`. The next deploy log shows `==> Checking the app database role ...` and PASS.

Exposure notes: the password exists only in the 600 files, in the shell variable of one command, and, while a
`docker run -e` container runs (seconds), in `docker inspect` for users of the docker group (on these servers only
`deploy`). Postgres receives only a SCRAM verifier, never the plaintext, so a server log of DDL cannot leak it. Rotate:
a new password file, step 3 with it, steps 4 to 7.

**Prod** (env files live on your Mac in `~/ammari-secrets`, uploaded by `deploy-prod/upload-prod-env.sh`; never re-run
`make-prod-env.sh` for admin/web afterwards without carrying the new `DATABASE_URL` over, it would put the owner back):

1. On the Mac: `(umask 077 && grep '^DATABASE_URL=' ~/ammari-secrets/prod-admin.env > ~/ammari-secrets/prod-migrator.env && echo 'APP_DB_ROLE=ammari_app' >> ~/ammari-secrets/prod-migrator.env)`
   and `(umask 077 && openssl rand -hex 32 > ~/ammari-secrets/prod-app-db-password)`.
2. `deploy-prod/upload-prod-env.sh` (uploads `prod-migrator.env` as `env/migrator.env`; the admin/web files are still
   the old ones, so nothing changes yet; until step 6 the deploy check would FAIL on admin/web, so do not deploy
   between steps 2 and 6, or finish R1 in one sitting).
3. Create the role, the password going over ssh stdin only:
   `ssh -i ~/ammari-secrets/ammari_prod_deploy_key deploy@43.173.52.121 'cd /opt/ammari-prod && APP_DB_PASSWORD="$(cat)" docker run --rm --network ammari-prod_internal --env-file env/migrator.env -e APP_DB_PASSWORD ghcr.io/tangguhriyadi/ammari-migrator:<sha> node_modules/.bin/tsx src/ops/setup-app-role.ts' < ~/ammari-secrets/prod-app-db-password`
   Expect `PASS ammari_app is ready`.
4. On the Mac: `(umask 077 && PW="$(cat ~/ammari-secrets/prod-app-db-password)" awk -F= '/^DATABASE_URL=/{ sub(/^DATABASE_URL=/, ""); sub(/^postgres(ql)?:\/\/[^@]*@/, "postgresql://ammari_app:" ENVIRON["PW"] "@"); print; exit }' ~/ammari-secrets/prod-migrator.env > /tmp/app-db-url)` and the same `grep ... REWRITTEN` test as on dev.
5. **Pre-flight login** over ssh stdin:
   `ssh -i ~/ammari-secrets/ammari_prod_deploy_key deploy@43.173.52.121 'cd /opt/ammari-prod && APP_DATABASE_URL_ADMIN="$(cat)" docker run --rm --network ammari-prod_internal --env-file env/migrator.env -e APP_DATABASE_URL_ADMIN ghcr.io/tangguhriyadi/ammari-migrator:<sha> node_modules/.bin/tsx src/ops/check-app-role.ts' < /tmp/app-db-url`
   must print `PASS ... admin log in as it`.
6. `deploy/set-env-var.sh ~/ammari-secrets/prod-admin.env DATABASE_URL < /tmp/app-db-url`,
   `deploy/set-env-var.sh ~/ammari-secrets/prod-web.env DATABASE_URL < /tmp/app-db-url`, `rm /tmp/app-db-url` (also if a
   step fails). Keep `prod-app-db-password` in `~/ammari-secrets` (needed to rebuild the URL).
   Then `deploy-prod/upload-prod-env.sh`, and on the VPS `./recreate-active-slot.sh admin` and `./recreate-active-slot.sh web`
   (a few seconds of restart per app; the inactive slots pick the new env up at the next deploy).
7. Check as on dev step 7 (with `--network ammari-prod_internal`, on the VPS), plus `deploy-prod/go-live-check.sh` from
   the Mac.
8. `db.env` and the backup are unchanged: `pg-backup.sh` dumps as the container superuser, not as either app role.

**Rollback of R1** (an app error that names a permission): put the owner URL back (dev: `sed -n 's/^DATABASE_URL=//p'
env/migrator.env | ./set-env-var.sh env/admin.env DATABASE_URL`, the same for web.env; prod: the same on the Mac files,
then upload) and recreate admin/web, AND remove the `APP_DB_ROLE=` line from `migrator.env` (dev on the server, prod in
`prod-migrator.env` + upload), or the next deploy's check fails because admin/web log in as the owner. Keep the file
itself (migrations keep running as the owner); never delete it while admin.env holds the app role's URL (migrations
would then run as the app role and fail). Send me the error line; a missing grant is a bug in `setup-app-role.ts`.
A prod rollback deploy (`--skip-migrate`) only warns on a failed check, so a release can always be rolled back.

**Later migrations:** tables a migration creates as the owner get the app role's grants through the default
privileges; the deploy's check fails (before any app container is touched) if one did not. Fix: re-run step 3
without `APP_DB_PASSWORD` (it re-applies the grants), then deploy again. Renaming or dropping a table in
`PROTECTED_TABLES` (packages/db/src/ops/app-role.ts) needs that list updated in the same release.

### R2. Posting cron

No setup: the cron service uses the existing `INTERNAL_CRON_SECRET` (docs/deploy.md "Internal cron service") and the
deploy recreates it with the new `cron.sh`. Check on each server, about 30 s after a deploy:
`docker compose logs --tail 50 cron | grep accounting` shows `/api/internal/accounting/posting -> 200 {"runId":...}`,
then one line every 15 minutes. `200 {"skipped":"running"}` or `{"skipped":"posting_in_progress"}` is fine (another
cron job or a staff "Posting sekarang" was running). `ERROR ... 500` means a key failed to post or the run failed (see
`docker compose logs web | grep accounting` and Akuntansi > Jurnal umum, "Perlu dicek"); retried every 5 minutes;
`ALERT: the accounting posting run has failed 3 times in a row` after about 45 minutes of failures. In admin, Jurnal
umum shows "Posting terakhir ... (otomatis)" and no "Posting otomatis belum ..." warning once the cron has run.

### R3. Verification checks

- App role: `check-app-role.ts` (R1 step 7), run automatically by every deploy once `env/migrator.env` has
  `APP_DB_ROLE`; a failure stops the deploy before any app container is touched.
- Posting completeness: Akuntansi > Rekonsiliasi, check 5 ("no gaps" after a posting run); month close refuses while
  it has gaps (Session 11).

### R4. Data-only restores

A full `pg_restore` of a `pg_dump` (what `pg-backup.sh` makes and `restore-drill-local.sh` proves) is fine: the dump
creates the triggers after loading the data. A **data-only** restore or a hand `COPY` into the journal tables is not:
`journal_entries_guard_insert` forces `created_at = now()` and lines are refused outside their entry's own
transaction, so the restored rows would be refused or re-stamped. If one is ever needed, it runs as the owner (never
as `ammari_app`, which cannot disable triggers), inside one transaction with `SET session_replication_role = replica`
(skips the ordinary triggers) and the deferred balance check verified afterwards with the Neraca saldo; ask me first.
Never on the live database: restore into a scratch database and compare.

### R5. Index suggestions (only once real volume exists)

Not built: at today's volume (thousands of lines a month) the existing indexes are enough. Revisit when Buku besar or
Neraca saldo takes more than about a second, or `journal_lines` passes about 200.000 rows
(`select count(*) from journal_lines`). Then, as a normal reviewed migration (`CREATE INDEX` in a migration file, never
by hand on the server):
- `journal_lines (account_code) INCLUDE (entry_id, debit, credit)`: index-only scans for the ledger and trial balance.
- Partial dimension indexes: `journal_lines (channel_id) WHERE channel_id IS NOT NULL`, and the same for
  `supplier_id`, `order_id` and `cash_account_code` (Laba rugi per saluran, the per-order and per-supplier
  reconciliation checks).

### R6. Year-end close

Nothing to run: one month per close, months locked in ascending order, the PPh final and year-end closing journals
posted before the month is set closed (apps/admin/src/lib/accounting/periods.ts). Close December 2027 only after
January to November 2027 are closed; reopen only newest first.

---

## 13. Go-live checklist (before 1 Jan 2027)

**Must be done on prod before 1 January 2027:**

1. **Deploy** the Session 12 release (migrations 0049 to 0056) to dev, test there, then to prod through the normal
   release (fast-forward `main`, "Deploy (prod)"); R0 pre-check first.
2. **Backup:** confirm the nightly backup ran after the deploy (`deploy-prod/go-live-check.sh`, backup freshness), and run
   `deploy-prod/restore-drill-local.sh` once against a post-0056 backup.
3. **Migrations** 0049 to 0056 applied on prod (the deploy log `Migrations applied successfully`; Akuntansi pages open).
4. **Cron:** R2 on prod; Jurnal umum shows "(otomatis)" and no cron warning.
5. **TRUNCATE revoke:** R1 on prod (dev stays on the owner for now, owner 27 Nov 2026; its deploys keep warning); the
   next prod deploy log shows the app role check PASS.
6. **December 2026 trial month:** let the engine post December, work through "Perlu dicek" and Rekonsiliasi weekly
   (December is never closed and is not part of the official books).
7. **Saldo Awal** (opening balance as of 31 Dec 2026, dated 1 Jan 2027): from 1 January, in Akuntansi > Saldo awal:
   confirm each system-proposed line and type Kas, Bank (bank statements), Saldo Penjual Shopee/TikTok, Piutang
   Midtrans and Saldo Biteship (dashboards on 31 Dec), fixed assets; post it while January is open, then close Ekuitas
   saldo awal into Modal pemilik once approved.
   **Before entering it (owner, 28 Nov 2026): import every December 2026 Shopee "Pesanan Saya" export first**, so each
   December order's ship date (col 7, marketplace-import.md §19.3) is filled. The 1-1505 proposal (Barang terjual belum
   dikirim) uses the recognition date: an order shipped in the app before 1 Jan without its Shopee ship time is treated
   as recognised before the books (the sales rule's `none`) and left out, so a ship date filled only after the opening
   is posted could put the order on the wrong side of the cut-over. Check Akuntansi > Perlu dicek shows no December
   `marketplace_ship_date_missing` for Shopee before confirming the proposal.
8. **Pengaturan Pajak:** the initial row ends on 2026-12-31 (original PP 55/2022). Once the PP 55 revision is
   confirmed, the accountant adds a row effective 2027-01-01 with the new `rate_valid_until`; until then every 2027
   close warns and proposes no PPh final (D-20). If no extension materialises, the accrual design must be revisited (§9).
9. **Mapping review by the accountant:** Akuntansi > Pemetaan akun (every expense category and item, methods, channels)
   and Data Master Akun (codes, names, Kas & Bank list); no category left unmapped (D-25).
10. **Manual journals the system cannot make** start in January: Biteship top-ups, Shopee withdrawals (M3; TikTok
   payouts post automatically since T8 once the TikTok finance sync runs),
   Midtrans payouts (W5 until fee work B), refunds that went through Midtrans.
11. January 2027 closes by 10 February 2027 (D-23).

**Stays pending (not blockers for 1 January, but known gaps):**

- **Session 5 (real marketplace ship/complete dates, D-2): TikTok replaced by tiktok-shop-integration.md T5/T8**
  (`orders.marketplace_shipped_at` = TikTok `collection_time`, read by the sales loader). **Shopee: 7a and 7b done
  (28 Nov 2026)**, the import writes the real ship/complete dates and the 1-1505 proposal uses the recognition date;
  **saving stays locked until 7c** (the owner's second real export, marketplace-import.md §19.10). Until then every
  Shopee order shipped from 1 Dec (and a TikTok order whose `collection_time` is not known yet) is the posting issue
  `marketplace_ship_date_missing` (no revenue journal is guessed). January cannot close cleanly without 7c or a
  reasoned close override.
- **MDR fee work A/B (D-8):** not built. W2/W5 and Rekonsiliasi check 3a stay off and the MDR "still an estimate" close
  warning is dormant; Midtrans payouts and fees go in by manual journal (W5 note in §4.2). Turning them on is part of that
  feature (add the loaders to `defaultPostingSources`, the warning to `periodWarnings`), plus the check 4 fix noted in
  Session 10.
- The accountant's open items in §10: the PP 55 revision, the mapping review, the PT's accounting standard (D-24).
