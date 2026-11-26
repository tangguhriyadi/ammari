# Accounting module (double-entry general ledger)

Status: **PLAN, not approved for implementation.** No code written. Investigation date 2026-11-26
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
  nullable/defaulted `source` column on `order_channel_fees` — that feature's own migration.)
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
  - 1-1300 Saldo pembayaran & marketplace — 1-1301 Piutang Midtrans 🔒, 1-1302 Saldo Penjual Shopee 🔒, 1-1303 Saldo Penjual TikTok 🔒, 1-1305 Saldo marketplace belum dipilah 🔒 (clearing for unallocated marketplace-balance spend [D-11])
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
| W9 | Biteship booking charged (`shipment`,id,`charged`) — a shipment attempt with `cost_amount` set and `booked_at` set | `booked_at` | Dr 2-1203 Titipan ongkir the order's `shipping_amount` (at most `cost_amount`) · Dr 6-1302 Subsidi ongkir website the order's `shipping_subsidy_amount` (at most what is left) · Dr/Cr 6-1301 Beban ongkos kirim the rest (courier price above or below the quote) / Cr 1-1603 Saldo Biteship `cost_amount`. A later change of `cost_amount` → reverse + repost. A manual order booked through Biteship has no subsidy: everything above its `shipping_amount` → 6-1301 [D-10]. |
| W10 | Biteship booking cancelled after it was charged (`shipment`,id,`cancelled`) | `cancelled_at` | Exact negation of W9 (Biteship puts the money back on the balance). The re-booked next attempt posts its own W9. |
| W11 | Biteship top-up, subscription, return charges | — | Top-up: **manual journal** (template "Top-up Biteship") Dr 1-1603 / Cr Bank — the system has no record of top-ups ([D-10]). Subscription (Grow ≈ Rp149.000/month): a business expense (E1) with item "Biteship Grow" → 6-2501. Return-shipping or other deductions not in `shipments`: found when reconciling 1-1603 with the Biteship dashboard, booked by manual journal Dr 6-1301 / Cr 1-1603. |
| W7 | Voucher | at S3 | Contra revenue 4-1201 (the `discount_amount` in S3) [D-4]. No entry at issue, void or restore. |
| W8 | `amount_mismatch` | — | No special entry: the difference stays in 2-1201 and appears in the reconciliation (§6.3). |

### 4.3 Marketplace (Shopee, TikTok)

| # | Event | Date | Journal |
|---|---|---|---|
| M1 | Revenue | the order's **real ship time from the export file**, stored by the Session 5 import feature [D-2] | S3 with the balance account = 1-1302/1-1303 Saldo Penjual, Penjualan **gross** of fees [D-1]. Platform vouchers/coins are the platform's, not recorded. No real ship time in the file yet (e.g. imported while still `to_ship`, or the column empty) → no M1, a posting issue until a later upload fills it; never the import time. The stored completed time is kept for reference and reconciliation only (recognition is at shipping [D-1]). |
| M2 | Platform fees (`order`,id,`channel_fees`) — every component **except** `payment_gateway_fee` (that one is W2) | same date as M1 [D-5] | Dr 6-1201 Biaya platform (`admin_fee`,`service_fee`,`platform_commission`,`affiliate_commission`,`other`) · Dr 6-1202 Subsidi ongkir penjual (`seller_shipping_subsidy`) / Cr Saldo Penjual. A re-upload that changes a fee → reverse + re-post; if M1's month is closed, the difference lands in the **first open month** [D-5]. |
| M3 | Withdrawal to bank / payout [D-11] | — | **Manual journal for now:** Dr 1-1201 Bank utama / Cr Saldo Penjual, from the bank statement, until the income ("Penghasilan") import fills `order_settlements`; then a rule `settlement → Dr/Cr Saldo Penjual` with the difference to 6-1201. |
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
   - **Accrual** = taxable(m) × `rate_bps` / 10000, rounded down to whole rupiah, using the
     `tax_settings` row effective for month m (§2.1).
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
| Arus kas | **Direct method** proposed (readable for the owner: "uang masuk dari penjualan, keluar ke pemasok"): every line on a cash/bank/saldo account classified by the counter-account's `cash_flow_group`. Indirect also derivable later. Note: SAK EMKM's required statements are Neraca, Laba rugi and CALK; arus kas is extra. |

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
| **5** | **Feature D-2 — real marketplace dates.** Expand-only migration: nullable `orders.marketplace_shipped_at`, `orders.marketplace_completed_at` (names final in that session's plan); the Shopee (and prepared TikTok) import maps the export file's ship/complete time columns into them, on create **and** on every re-upload (later uploads fill dates that were empty). Never overwrites the app's own `shipped_at`/`completed_at` (management screens keep working). Order detail shows both. No "upload by the 3rd" rule. | Unit: column parsing (Jakarta time, empty cell → NULL, malformed → import row error, not a silent NULL). DB: import then re-import fills the date; re-import never clears an existing date. `silent-failure-hunter` review (import code). |
| **6** | **Feature D-3 — manual-order payment.** New table `order_manual_payments` (`order_id` PK, `method` cash/transfer/card, `cash_account_code` → `accounts`, recorded by/at; audited), written by the manual-order create/edit form; **required** for new WhatsApp/Instagram/offline/manual-web orders; account picker lists active Kas & Bank accounts (today Kas tunai + Bank utama [D-17]), defaulting from the method mapping; an "isi metode bayar" action fills it for older orders. No credit option. | Unit: method → default account; card → Bank utama. DB: order + payment row in one transaction; missing row → posting issue (once Session 9 posts rule S6). e2e: create a manual order with method/account at 390/1280. |
| 7 | Purchases chain: P1, P2, P3 (with chain), P5, P6, P7; reconciliation checks 1 (bahan) and 2 (utang); **ledger-side guard test** that purchase/payment rules never debit an expense [D-14]. | Unit: chain allocation (DP before receipt, partial receipts, reversal returns advance, overpaid close). DB: against real receipts from fixtures; Σ P1 = tagihan for closed docs. |
| 8 | Production: R1–R5, A1, A2; reconciliation for 1-1503/1-1504/1-1506. | Unit: R3 split — normal completion residue → 5-1201, short-close rest → 6-4102 [D-15]; A1/P7 → 6-4101/6-4102 [D-16]; scoped cost lines. DB: post → receive partially → short-close (the Haura beige L case: 12 planned, 6 received) → reopen → close; ledger = stock valuation. |
| 9 | Sales: S1–S6 (S6 reads `order_manual_payments`, dated `paid_on`; a corrected record → reverse + repost into the first open month), W1, W3, W4, W6–W11, M1 (real dates from Session 5), M2, M4; checks 3, 3b, 3c. W2/W5 rule code + tests ship here against fixture rows shaped like fee work A/B (component `payment_gateway_fee`, `source`, `order_settlements`); they post real data only once A+B are deployed. | Unit: per channel × status path (paid→shipped→completed; paid→cancelled→refunded; shipped→returned; re-import fee change into a closed month → first open month); marketplace order without real ship date → issue; manual order without a payment record → `manual_payment_missing`; S6 on `paid_on` then S3 on the ship date; payment record corrected after posting (incl. into a closed month) → reversal + repost in the first open month. DB: through `transitionOrderStatus` fixtures; 1-1504 + 1-1505 = stock valuation + to_ship cost. |
| 10 | **Neraca, Laba rugi, Arus kas** + PDF/Excel; reconciliation 4 (vs management P&L) and 5. | Unit: statement layout from a trial balance (6-4000 under beban usaha, not HPP). e2e: each report at 390/1280, export downloads. |
| 11 | Fixed assets + depreciation [D-19] (tax groups, zero residual, from acquisition month, Rp1.000.000 threshold), **PPh final accrual** from `tax_settings` [D-20], year-end closing; turn on W2/W5 and check 3a once fee work A+B (a separate post-launch feature) is live. | Unit: depreciation schedule (rounding in last month); PPh base/exemption crossing Rp500 juta mid-month; no accrual after `rate_valid_until`; rate change by a new effective row. DB: closing zeroes P&L accounts. e2e: asset register + tax settings at 390/1280. |
| 12 | Cron route for nightly/15-min posting, Rekonsiliasi page polish, docs (SPEC §5.x, runbook). | DB: concurrent runs serialise (advisory lock), no duplicates. |

Every session: `/plan` approval first, `database-reviewer` + `typescript-reviewer` +
`react-reviewer` at `/code-review`, and the migration file read before committing.

**Session 5 status: BLOCKED (26 Nov 2026), deferred until real Shopee/TikTok export files are
available.** The repo has no evidence of a ship-time or complete-time column for either marketplace:
the Shopee adapter's columns come from a public article and are not verified (`SHOPEE_MAPPING_VERIFIED
= false`, marketplace-import.md O1), and the TikTok adapter has no columns at all (O3). Nothing is
guessed. Waiting for, per marketplace, a real export **header row** (no buyer data) and for the ship
time and complete time columns: the exact header text, the value **format** (text such as
`2026-12-03 14:22` or an Excel date cell), the **empty-value form** of an order not yet shipped or
completed (empty cell, `-`, other), and whether the value is **the same on every row of an order**.
The **full TikTok column mapping** is its own task (it is a prerequisite for any TikTok import, not
part of Session 5). Until Session 5 ships, a marketplace order without a real ship date stays a
**posting issue** (M1, §4.3; never the import time), and the opening-balance 1-1505 proposal still
reads `orders.shipped_at` (the import time for marketplace orders), to be switched to the real ship
time by Session 5.

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
  cheaper than the quote could never credit 6-1301. To confirm with the owner/accountant.
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

**Session 12 (cron, Rekonsiliasi polish, docs and runbook):**
- **Runbook: revoke TRUNCATE.** Row-level triggers do not fire on `TRUNCATE`, so `TRUNCATE
  journal_lines` (or `journal_entries CASCADE`) bypasses every append-only guard; the same holds for
  the existing append-only tables. Decided (26 Nov 2026): no TRUNCATE triggers (e2e-db.ts resets
  its own database with TRUNCATE). Instead, on prod and dev, `REVOKE TRUNCATE` from the app's
  database role on every ledger and append-only table: `accounts`, `account_mappings`,
  `fiscal_periods`, `journal_entries`, `journal_lines`, `posting_runs`, `posting_issues`,
  `tax_settings`, `stock_movements`, `fabric_stock_movements`, `accessory_movements`,
  `defect_movements`, `goods_receipts`, `goods_receipt_items`, `supplier_payments`,
  `purchase_attachments`, `private_files`, `business_expenses`, `audit_log` (re-check the list
  against the schema when writing the runbook). The app role must not own these tables (an owner
  always keeps TRUNCATE and can disable triggers). Add a **verification check** run by the deploy
  pipeline or a health endpoint: `has_table_privilege(<app role>, '<table>', 'TRUNCATE')` is false
  for every table in the list, failing loudly otherwise.
- Runbook notes for data-only restores: `journal_entries_guard_insert` forces `created_at = now()`
  and lines are refused outside the entry's own transaction, so a data-only restore/`COPY` into the
  journal tables needs triggers disabled by the owner (a full `pg_restore` is fine: triggers are
  created after the data).
- Multi-month close (year end): lock months in ascending order, post the closing entries before
  setting `status = 'closed'`; two closers that both already hold a shared lock on the same month
  would deadlock (Postgres resolves it by aborting one). Document in the close code (Session 4
  builds it; record the rule there). *Done in Session 4: recorded in apps/admin/src/lib/accounting/periods.ts (one month per transaction today).*
- Constraint hardening: tie `entry_no`'s `YYYYMM` to `entry_date`; a lower bound on `entry_date`
  (the trial month start); the trial-month CHECK hardcodes `2026-12-01` (fine while D-22 stands).
- Indexes, once real volume exists: `journal_lines (account_code) INCLUDE (entry_id, debit,
  credit)` for index-only ledger/trial-balance scans; partial (`WHERE ... IS NOT NULL`) dimension
  indexes on `channel_id`, `supplier_id`, `order_id`, `cash_account_code`.
- Test hygiene: `migrationsUpTo` is duplicated in each `migration-00xx.test.ts` (move them to
  `packages/db/test/scratch-database.ts`); `accounting-ledger.test.ts` copies the whole migrations
  folder via `migrationsUpTo(Number.MAX_SAFE_INTEGER)` where `migrationsFolder` would do; its
  "nothing is left behind by a refused entry" test counts across the whole scratch database and
  passes vacuously when run alone with `-t`; `migration-0048.test.ts`'s comment "no later migration
  touches categories" is only true today.

---

## 9. Risks

- **The two small features slip past 1 Jan 2027** (Session 5 [D-2], Session 6 [D-3]): nothing is guessed —
  marketplace orders without a real ship date and manual orders without a payment record become
  posting issues. Recoverable: re-uploading the marketplace files fills the dates; the "isi metode
  bayar" action fills manual orders. January cannot close (by 10 Feb) until they are cleared.
- **Marketplace returns keep the import time** ([D-2] covers ship/complete dates only): S4 for a
  Shopee/TikTok return is dated when the return is imported; if that month is closed the return
  lands in the first open month. Acceptable under [D-23]; revisit if the export file gains a
  reliable return date.
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
