# Plan: Suppliers + Goods Receipt (penerimaan barang) + Defect Stock

Status: **owner answered both rounds of open questions (2026-10-19); all decisions recorded in §2.
Awaiting go-ahead to start session 1.** Plan only — no code, no migration, no commit.

Three linked changes:

1. A **supplier master** (`/suppliers`), mandatory on every purchase, and attached to cost
   components (so a sewing fee names which tailor is paid).
2. **Goods receipt**: posting a purchase or a production batch no longer adds stock. Stock only
   moves when goods are *received*, by the received quantity, in as many partial receipts as it
   takes.
3. **Defect stock** (*stok barang cacat*): units that arrive defective are recorded and enter a
   separate defect ledger — never sellable, never packed, never counted as sellable — and are
   later either exchanged by the supplier/tailor or **released** (*pelepasan*) by auction
   (*lelang*, with proceeds) or donation (*hibah*, Rp 0).

---

## 1. What exists today (verified against the code, not assumed)

This is the part that decides the shape of everything below.

**A "purchase" today is not a document.** It is *one row* in `accessory_movements` or
`fabric_stock_movements` with `type='purchase'`, carrying `qty`, `value_amount` (the exact total
paid), `purchased_at`, a free-text `supplier`, and a note
(`apps/admin/src/lib/inventory/accessories.ts:338`, `fabric-stock.ts`). `/purchases` is a
read-only UNION view over those two ledgers (`lib/inventory/purchases.ts`); `/purchases/new` is a
single-item form that writes the ledger row, and **stock increases at that instant**. There is no
header, no lines, no status, nothing to receive against. Corrections are already done the right
way: a reversing `purchase_void` row, blocked if any later movement exists for that item.

**Production.** `production_batches` is `draft → posted`, one-way. `postBatch`
(`lib/production/queries.ts:620`) consumes fabric + accessories, computes
`HPP/pcs = ceil(totalCost / totalPcs)`, writes **one `stock_movements` row per batch line**
(`type='production'`, `ref_type='production_batch_item'`), and freezes the batch. Three
hand-authored triggers (migration 0007/0008) make a posted batch immutable.

**The freeze trigger is column-scoped.** `prevent_posted_batch_field_change`'s `WHEN` clause names
exactly `status`, `fabric_yards`, `fabric_cost_amount`, `fabric_id`
(`0008_strange_sharon_carter.sql:142`). A *new* column on `production_batches` is therefore not
frozen by it, and we never have to touch that trigger — see D5.

**Cost components** are a services-only master now (`cost_components`: name citext unique, unit,
`default_unit_price`, `cost_type` variable/fixed, `is_active`, `sort_order`; seed ships only
"Ongkos jahit"). A batch's lines live in `production_batch_costs`, which **snapshots**
`component_name`/`component_unit`/`cost_type` at insert time and is frozen once the batch posts.

**Supplier is free text in three places today**: `fabrics.supplier`,
`accessory_movements.supplier`, `fabric_stock_movements.supplier`. Nothing joins on it.

**Every writer of a stock ledger** (exhaustive, grepped): `postBatch`, `adjustStock`,
`saveStockCount`, `decrementStockForOrderItems`/`restoreStockForOrderItems`,
`recordAccessoryPurchase`/`recordAccessoryAdjustment`/`voidAccessoryPurchase` and their fabric
twins. Packing never touches stock. The storefront's `available` flag is
`SUM(stock_movements.qty) > 0` (`packages/db/src/storefront/queries.ts:207`).

**Moving average, and the one helper that makes it exact.** Every ledger row carries its own
signed `qty` *and* `value_amount`; balance and value are always `SUM`, never a counter.
`valueDeltaForConsumption` (`lib/inventory/moving-average.ts`) values an outflow at the current
average **and** zeroes the residual exactly when a balance reaches 0, so `qty = 0 ⇒ value = 0`
holds despite rounding. Everything in §4 reuses it rather than inventing a second rule.

**Existing tab/permission precedent.** `/stock` (`stock.view`) and
`/stock/fabrics`, `/stock/accessories` (`inventory.view`) are three pages behind two independent
keys, joined by `StockTypeTabs`, which takes `canViewFinishedGoods`/`canViewRawMaterials` so it
never renders a tab the session would 403 on. Defect stock reuses that component and that split
exactly.

**Permissions** today: `inventory.view` / `inventory.manage` / `production.manage` / `stock.view` /
`stock.adjust` / `finance.view_profit`. **Nav groups** today: Utama, Operasional, Katalog, Konten,
Pertumbuhan, Administrasi — there is no "Data Master" group yet (Produk / Bahan / Aksesoris sit
under "Katalog").

**Data situation.** Prod has no products and no purchases. Dev has test data. `seed.ts` is
insert-only. Last applied migration is `0021`.

---

## 2. Decisions

Owner-answered questions are marked **[owner]**; the rest are design decisions that follow from
them. Everything here is settled; §10 lists what is still open.

| # | Decision |
|---|---|
| D1 | A purchase becomes a real document: `purchases` + `purchase_items`. Partial receipt and "ordered but not here yet" are not expressible as a ledger row. |
| D2 | **One** receipt table pair (`goods_receipts` + `goods_receipt_items`) serves both purchases and production output — same business act, same screen, same permission, same correction rule. |
| D3 | A receipt is the **only** new way sellable stock increases. Sale, return, manual adjustment and stock count are untouched. |
| D4 | Posting a production batch still **consumes** fabric/accessories and still computes HPP; it just stops creating finished-goods stock. Material is really consumed at cutting/hand-off; output arrives later. |
| D5 | `production_batches.status` keeps its exact current meaning (`draft`/`posted`); receipt progress goes in a **new** `receipt_status` column. This leaves the freeze trigger and the previous release's reading of `status` untouched → rollback-safe (CLAUDE.md expand/contract). |
| D6 | Purchase lines store `qty_ordered` + `total_amount` (what the owner typed, **ongkir included** **[owner Q8]**), not a unit price. Each receipt's value is a cumulative-rounding slice of that total (§4.2). Same "store exactly what was entered" rule as `fabrics.price_amount/price_unit`. |
| D7 | Once a line has any receipt, its `qty_ordered`/`total_amount`/item are frozen by a trigger. Editing the denominator afterwards would retroactively re-price receipts already posted. |
| D8 | Corrections are reversing entries, never edits — for receipts and for every defect movement **[owner Q2]**. Reuses the existing `purchase_void` mechanism on the raw-material ledgers; `stock_movements` is DB-immutable and gets an exact negating row. |
| D9 | Cost components get a **default** supplier on the master **and** a per-line override on the batch, snapshotted onto the line **[owner Q5]**. Per *line*, not per batch — one batch can have sewing by A and finishing by B. |
| D10 | New permission `inventory.receive` (post a receipt, including recording rejects). `inventory.manage` keeps the supplier master, purchase documents, short-close, reversals, **and every defect disposition** (return-to-supplier, release by lelang/hibah) — those destroy or convert value, so they sit above plain receiving. No separate defect permission; one rule regardless of item kind. |
| D11 | Legacy single-row purchases are **not** backfilled into documents, and their free-text supplier names are **not** mapped onto the master **[owner Q9]**. Prod has none; dev data is disposable. They keep their stock and stay visible on the item ledgers. |
| D12 | Nav: rename the "Katalog" group to **"Data Master"** and add "Pemasok" to it. Group labels are derived from `nav/config.ts` only; nothing asserts the string. |
| D13 | **Supplier fields [owner Q1]:** only **Nama** is required. Optional: Jenis (multi-select Kain / Aksesoris / Jasa (penjahit) / Lainnya), telepon/WhatsApp, alamat, nama bank, nomor rekening, nama pemilik rekening, catatan. `is_active` defaults to active. Jenis is a **soft filter only** — pickers sort matching kinds first, never block. |
| D14 | **Rejects go into defect stock [owner Q2]**, per product variant for production output and per fabric/accessory for purchases, in a dedicated `defect_movements` ledger. A *separate table* — not an `is_defect` flag on the existing ledgers — so "never sellable, never ordered, never packed, never counted as sellable" is structural, not a `WHERE` clause eleven existing queries would each have to remember. |
| D15 | A defect is later **exchanged** (leaves defect stock as `return_out` against its source line; the replacement arrives through the normal receipt flow against the **same** document, which can then reach fully received) or **released** (`dispose`, D24). Regrading a defect back into sellable stock is out of scope (D25). |
| D16 | **One quantity drives both valuation and outstanding**: `qtySettled(line) = accepted + rejected_total − returned_out` (all net of reversals), and `outstanding = qty_ordered − qtySettled`. A return-to-supplier re-opens exactly the room its replacement needs (§4.2). |
| D17 | **Over-receipt is rejected entirely [owner Q6]** — nothing enters sellable *or* defect stock. `accepted + rejected` on a receipt line may not exceed `outstanding`; the form blocks it with a clear Indonesian error naming the line and the remaining quantity. |
| D18 | **A closed document can be re-opened**, but only by a return-to-supplier against it (which is what creates new outstanding). Requires `inventory.manage`, a reason, and an audit entry; sets `receipt_status`/`status` back to `partially_received` and stamps `reopened_at`/`reopened_by_staff_user_id`/`reopen_reason`. No other path re-opens a closed document. |
| D19 | **One close button with a required reason [owner Q7]**; the server stores `cancelled` when nothing ever arrived (accepted = 0 **and** rejected = 0) and `closed` otherwise. Both leave stock and cost alone. |
| D20 | **HPP is never rewritten** **[owner Q2, retained]**. The frozen `unit_cost_amount` stands; defects and releases are shown as read-only variance on the document, computed from the **net loss** (defect value released minus proceeds) — §4.3. |
| D21 | **Receipt date defaults to today (Jakarta), backdatable; the receiver is the logged-in staff user, plus an optional free-text "Diterima oleh" [owner Q3].** |
| D22 | **Received quantity is immediately sellable [owner Q4]** — no extra gate. Unreceived quantity simply isn't in stock, and the existing "stok tidak cukup" check already refuses it. |
| D23 | **Defect stock is pooled per item [owner N1]**, and every movement names its source line, so "which order or batch did these defects come from" stays answerable while only the *value* average is pooled — consistent with every other balance in this system. No lot-level defect costing. |
| D24 | **Releasing a defect (`dispose`) has exactly two types [owner N2]**: **Lelang** (auction — `proceeds_amount` entered by hand, required, **> 0**) and **Hibah** (donation — proceeds fixed at **Rp 0**). Both need a date (`occurred_at`, defaults today, backdatable) and required free-text notes; `disposal_type` carries the category, so there is no separate closed-set reason. Both remove quantity *and* value from the defect pool through the defect ledger, with an audit entry and the same reversing-entry rule as everything else (D8). `proceeds_amount` is **stored but not booked** — no journal entries, no accounting module in this plan; it is persisted precisely so a future double-entry module can book it as other income. Proceeds mean **gross cash actually received** (what reached her hand or account), with no fee breakdown, since there is no expense module to tie fees to yet. |
| D25 | **Regrading a defect into sellable stock is out of scope [owner N2]**, and deliberately unreachable today (the two ledgers are separate tables, so no manual adjustment can do it). The future shape is recorded in §3.5 so nobody improvises it: one new `DEFECT_MOVEMENT_TYPES` value that moves quantity and value out of the defect pool and inserts a matching sellable `adjustment` in the same transaction. |
| D26 | **No Overview dashboard tile for defect stock now [owner N3]**, so nobody adds one ad hoc mid-session. SPEC §6 is untouched by this plan. |
| D27 | **A posted batch's planned quantity is not editable [owner N4]** — short-close instead, which is what it is for, and the existing freeze trigger already guarantees it. "Sisa" on a short-closed batch stays non-zero forever; the `closed` badge is what resolves that visually. |
| D28 | **No per-supplier payable or amount-owed view now [owner N5]**, but the schema must stay able to support one: `purchases.supplier_id` plus `production_batch_costs.supplier_id` (D9) are together sufficient, and neither may be "simplified" away. |

---

## 3. Schema

### 3.1 `suppliers` (migration 0022)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `name` | `citext` NOT NULL **unique** | The only required field (D13). Same idiom as `cost_components.name` — "Laksmi" and "laksmi" must collide. |
| `kinds` | `text[]` NOT NULL default `'{}'` | Subset of `SUPPLIER_KINDS = ['fabric','accessory','service','other']`, no duplicates, max 4 — reuses `checkArraySubset` + `text_array_has_duplicates` exactly as `products.highlights` does. Empty is valid. |
| `phone` | text | One field for both call and WhatsApp (`wa.me` link built in the UI). |
| `address`, `bank_name`, `bank_account_no`, `bank_account_name`, `notes` | text | All optional, no pair checks — partial info is realistic and this is reference text for a human making a transfer. |
| `is_active` | boolean NOT NULL **default true** | No hard delete, ever, once referenced — same rule as `cost_components`/`accessories`/`fabric_colors`. The `ON DELETE RESTRICT` FKs below are the backstop. |
| `timestamps()` | | |

### 3.2 `purchases` + `purchase_items` (migration 0024)

`purchases`:

- `id`, `purchase_no` text **unique** (`PO-YYYYMM-NNN`, §4.1)
- `supplier_id` → `suppliers` **NOT NULL**, restrict  ← "every purchase must have a supplier"
- `ordered_at` date (Jakarta), `notes`
- `status` text NOT NULL default `'ordered'`, CHECK in
  `PURCHASE_STATUSES = ['ordered','partially_received','received','closed','cancelled']`.
  No `draft` — the owner records purchases she has already placed; a draft step buys nothing.
- `closed_at`, `closed_by_staff_user_id` → `staff_users` restrict, `close_reason` text;
  `reopened_at`, `reopened_by_staff_user_id` → `staff_users` restrict, `reopen_reason` text (D18,
  added in 0027)
- `created_by_staff_user_id` → `staff_users` restrict, `timestamps()`
- CHECKs: `status in ('closed','cancelled')` **implies** `closed_at is not null` (one-directional,
  so a re-opened document keeps the record of its last close); `(closed_at is not null) =
  (closed_by_staff_user_id is not null)`; same pair check for the three reopen columns
- indexes: `supplier_id`, `status`, `(ordered_at desc)`, and every RESTRICT-FK column (this
  codebase's standing rule)

`purchase_items`:

- `id`, `purchase_id` → `purchases` cascade
- `item_type` text CHECK in `['fabric','accessory']`
- `fabric_id` → `fabrics` restrict (nullable), `accessory_id` → `accessories` restrict (nullable)
- CHECK `(fabric_id is null) <> (accessory_id is null)` **and** `item_type` agrees with whichever
  is set — the same "exactly one target" idiom as `product_accessory_recipes`
- `qty_ordered` numeric(10,2) CHECK `> 0`; CHECK
  `item_type <> 'accessory' or qty_ordered = round(qty_ordered)` (accessories are whole pcs;
  fabric is yards with 2 decimals, matching `fabric_stock_movements.qty`)
- `total_amount` bigint CHECK `>= 0` — what the owner typed, ongkir included (D6)
- partial uniques, mirroring `product_accessory_recipes`:
  `unique(purchase_id, fabric_id) where fabric_id is not null`,
  `unique(purchase_id, accessory_id) where accessory_id is not null` — the same item cannot appear
  twice in one purchase
- `unique(id, fabric_id)`, `unique(id, accessory_id)` — composite-FK targets for
  `defect_movements` (§3.5); nullable columns are fine as FK targets under Postgres's default
  MATCH SIMPLE, exactly as `product_images_fabric_color_fabric_fk` already relies on
- indexes `purchase_id`, `fabric_id`, `accessory_id`
- **no `qty_received`/`qty_rejected` columns** — those are always `SUM`s over the receipt/defect
  ledgers, never mutable counters (the rule every balance in this schema follows)

**Freeze trigger** `prevent_received_purchase_item_change` (hand-authored, modelled on
`prevent_posted_batch_field_change`): reject any UPDATE of `qty_ordered`, `total_amount`,
`item_type`, `fabric_id`, `accessory_id` — and any DELETE — on a `purchase_items` row that already
has a non-reversed receipt item (D7).

### 3.3 `goods_receipts` + `goods_receipt_items` (migration 0024)

`goods_receipts`:

- `id`, `receipt_no` text **unique** (`GR-YYYYMM-NNN`)
- `source_type` text CHECK in `['purchase','production_batch']`
- `purchase_id` → `purchases` restrict (nullable), `production_batch_id` → `production_batches`
  restrict (nullable), CHECK exactly one set and agreeing with `source_type`
- `kind` text CHECK in `['receipt','reversal']`
- `received_at` date (Jakarta), defaults to today, backdatable (D21) — a display/reporting label;
  the ledger's own ordering stays insertion order, the same note the raw-material plan already
  makes about `purchased_at`
- `received_by_name` text nullable — only for "someone else physically took delivery"; the real
  actor is always `created_by_staff_user_id` (D21)
- `reverses_receipt_id` self-FK restrict, **unique**; `reversed_at`, `reversed_by_staff_user_id`
  set once on the original. Pair checks mirror `accessory_movements`' void columns exactly:
  `(kind='reversal') = (reverses_receipt_id is not null)`,
  `(reversed_at is not null) = (reversed_by_staff_user_id is not null)`,
  `reversed_at is null or kind = 'receipt'`
- `note`, `created_by_staff_user_id` → `staff_users` restrict NOT NULL, `createdAtOnly()`
- `unique(id, source_type, kind)` — the composite-FK target for the items below
- indexes: `(purchase_id, created_at)`, `(production_batch_id, created_at)`, `(received_at desc)`,
  and each RESTRICT-FK column

`goods_receipt_items`:

- `id`, `goods_receipt_id` cascade
- `source_type`, `kind` — denormalized copies existing only so **one** composite FK
  `(goods_receipt_id, source_type, kind) → goods_receipts(id, source_type, kind)` guarantees at the
  DB level that an item can never disagree with its own header. Exactly the
  denormalize-plus-composite-FK technique `product_variants.fabric_id` and
  `production_batch_items.fabric_id` already use.
- `purchase_item_id` → `purchase_items` restrict (nullable), `production_batch_item_id` →
  `production_batch_items` restrict (nullable), CHECK exactly one set and agreeing with
  `source_type`
- `qty_accepted` numeric(10,2) — deliberately **not** named `qty_received`: "received" is
  `accepted + rejected`, and conflating them is exactly the bug this feature is about. Signed: a
  reversal item is the exact negation of the original's, so every balance stays a plain `SUM`.
- `qty_rejected` numeric(10,2) NOT NULL default 0 (added in migration 0026, §3.5) — what arrived
  defective; mirrored 1:1 into `defect_movements` in the same transaction
- CHECKs: `kind='receipt'` ⇒ both `>= 0`; `kind='reversal'` ⇒ both `<= 0`;
  `qty_accepted + qty_rejected <> 0` (a line must do something — a 0-accepted / 2-rejected line is
  legitimate); whole numbers for production and accessory sources (fabric yards are the only
  fractional case)
- partial uniques `unique(goods_receipt_id, purchase_item_id)` /
  `unique(goods_receipt_id, production_batch_item_id)` — one line per source line per receipt
- indexes on both source-id columns (they back the per-line `SUM` *and* the RESTRICT checks)

### 3.4 Ledger plumbing (migrations 0024 + 0025)

- `RAW_MATERIAL_MOVEMENT_REF_TYPES` += `'goods_receipt'`; `STOCK_MOVEMENT_REF_TYPES` +=
  `'goods_receipt_item'`. Both arrays back live CHECK constraints, so both constraints get
  rewritten in the migration.
- `accessory_movements` / `fabric_stock_movements`: add `supplier_id` → `suppliers` restrict
  (nullable — legacy rows have none) + index. The existing free-text `supplier` column **stays**
  and is written with the supplier's *name at receipt time* — a snapshot, so a later rename never
  rewrites a ledger line (same reasoning as `production_batch_costs.component_name`).
- `accessory_movements` / `fabric_stock_movements`: add
  `uniqueIndex(type, ref_type, ref_id) where ref_type = 'goods_receipt'` — a double-posted receipt
  becomes impossible at the DB level, mirroring `stock_movements_type_ref_unique_idx`.
- `stock_movements_type_ref_unique_idx`: widen its `WHERE` from
  `ref_type in ('order_item','production_batch_item')` to also include `'goods_receipt_item'`
  (drop + create; a partial index's predicate cannot be altered in place).
- `production_batches`: add `receipt_status` text NOT NULL default `'pending'`, CHECK in
  `PRODUCTION_RECEIPT_STATUSES = ['pending','partially_received','received','closed']`, plus CHECK
  `status <> 'draft' or receipt_status = 'pending'`, plus the same close columns and one-directional
  pair check as `purchases` (its reopen columns, like theirs, arrive in 0027 with S6). Index
  `receipt_status`. **No trigger change needed** — see §1.

### 3.5 `defect_movements` (migration 0026)

One append-only ledger for all three item kinds, discriminated the same way
`product_accessory_recipes` and `goods_receipt_items` already discriminate theirs. The table is
created **complete** in 0026, including the `dispose` movement type and its two disposal columns,
even though nothing writes them until S6 — creating the table once beats an ALTER plus a second
CHECK migration two sessions later, and an unused allowed value in a CHECK costs nothing.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `item_kind` | text CHECK in `DEFECT_ITEM_KINDS = ['sku','fabric','accessory']` | |
| `sku` | → `product_variants.sku` restrict, nullable | |
| `fabric_id` | → `fabrics` restrict, nullable | |
| `accessory_id` | → `accessories` restrict, nullable | |
| | | CHECK exactly one of the three is non-null **and** agrees with `item_kind`. These are the balance key; keeping them denormalized (rather than joining through the source line) is the same choice `production_batch_items.fabric_id` makes. |
| `type` | text CHECK in `DEFECT_MOVEMENT_TYPES = ['reject','return_out','dispose','reversal']` | One `dispose` type carrying a `disposal_type`, **not** one movement type per disposal kind: the quantity/value mechanics are identical and only the proceeds differ, so a third or fourth disposal kind later (N-new-1) is one array value and one radio option, with no new code path. |
| `qty` | numeric(10,2) signed, CHECK `<> 0` | CHECK `type <> 'reject' or qty > 0`; CHECK `type not in ('return_out','dispose') or qty < 0`; a `reversal`'s sign is the exact negation of the row it reverses (app-enforced, same as `accessory_movements`' `purchase_void`). CHECK `item_kind = 'fabric' or qty = round(qty)`. |
| `value_amount` | bigint signed | Defect stock is its own moving-average pool per item — see §4.2/§4.3. |
| `goods_receipt_item_id` | → `goods_receipt_items` restrict, nullable | Set on `reject` rows (and on a reversal of one). CHECK `type <> 'reject' or goods_receipt_item_id is not null`. `uniqueIndex(goods_receipt_item_id) where type = 'reject'` — one reject movement per receipt line. |
| `purchase_item_id` / `production_batch_item_id` | → restrict, nullable | The source **line**, always set (copied from the receipt item on a `reject`), CHECK exactly one. This is what makes `qtySettled` per line computable without a join chain, and what makes "show this document's defects" a single indexed read. Composite FKs `(purchase_item_id, fabric_id) → purchase_items(id, fabric_id)`, the accessory twin, and `(production_batch_item_id, sku) → production_batch_items(id, sku)` guarantee a defect's item always matches its own source line (needs `unique(production_batch_items.id, sku)`, added in 0026). |
| `disposal_type` | text CHECK in `DEFECT_DISPOSAL_TYPES = ['auction','donation']`, nullable | Set on a `dispose` row **and copied onto its reversal**, so "proceeds by type" nets with a plain `SUM` and no self-join, exactly as `qty`/`value_amount` already do. CHECKs: `disposal_type is null or type in ('dispose','reversal')`; `type <> 'dispose' or disposal_type is not null`. |
| `proceeds_amount` | bigint signed, nullable | Whole rupiah (never a float — CLAUDE.md). CHECKs: `(disposal_type is null) = (proceeds_amount is null)` (both or neither, the same pair-check idiom as `fabrics_price_amount_unit_pair_check`); `type <> 'dispose' or disposal_type <> 'auction' or proceeds_amount > 0`; `type <> 'dispose' or disposal_type <> 'donation' or proceeds_amount = 0` (D24). Signed because a reversal carries the exact negation — app-enforced, like every other reversal column. Deliberately **not** netted against `value_amount`: the ledger records the cost that left the defect pool; proceeds are separate cash a future accounting module books as other income. |
| `occurred_at` | date (Jakarta) | Defaults today, backdatable, same role as `received_at`. |
| `reverses_movement_id` | self-FK restrict, **unique** | CHECK `(type='reversal') = (reverses_movement_id is not null)`. A reversal copies the reversed row's item and source-line columns so every per-line `SUM` nets correctly with no self-join. |
| `reversed_at`, `reversed_by_staff_user_id` | | Set once on the original. Same pair checks as `goods_receipts`. |
| `note` | text | Optional in general, **required and non-blank for a `dispose` row** (D24): CHECK `type <> 'dispose' or (note is not null and btrim(note) <> '')`. |
| `created_by_staff_user_id` (→ restrict, NOT NULL), `createdAtOnly()` | | |

Indexes: `(item_kind, sku/fabric_id/accessory_id, created_at)` per item column (the balance
query's shape), `purchase_item_id`, `production_batch_item_id`, `goods_receipt_item_id`, and each
RESTRICT-FK column.

**Immutability trigger** `prevent_defect_movement_mutation`, a copy of
`prevent_accessory_movement_mutation`: DELETE always rejected; UPDATE rejected unless the only
columns changing are `reversed_at`/`reversed_by_staff_user_id`, going from NULL, exactly once
(same `to_jsonb(NEW) - 'reversed_at' - 'reversed_by_staff_user_id'` projection comparison).

**Reserved for later, not built (D25):** regrading a defect back into sellable stock would be one
additional `DEFECT_MOVEMENT_TYPES` value (e.g. `regrade`) that moves quantity and value out of the
defect pool and inserts a matching sellable `adjustment` movement in the same transaction. Written
down here so it is added that way rather than improvised as a pair of unrelated manual
adjustments — which is impossible today anyway, since the two ledgers are separate tables.

### 3.6 Cost-component supplier (migration 0023)

- `cost_components.default_supplier_id` → `suppliers` restrict, nullable, + index.
- `production_batch_costs.supplier_id` → `suppliers` restrict, nullable, + index, and
  `supplier_name` text nullable — the same snapshot pair as `component_name` (a tailor renamed
  later must not rewrite a posted batch). Both written at line insert, prefilled from the
  component's default, overridable per line. `prevent_posted_batch_cost_mutation` already freezes
  them once posted; nothing to change there.

---

## 4. The logic that actually needs care

### 4.1 Document numbers

Generalize `lib/production/batch-number.ts` into `lib/documents/document-number.ts`:
`nextDocumentNumber(tx, prefix, table, column)` with the identical per-month
`pg_advisory_xact_lock(hashtext(prefix))` + `max(split_part(no, '-', 3)::int)` logic;
`generateBatchNumber` becomes a thin caller. Prefixes: `PRD-` (unchanged), `PO-`, `GR-`. Each
number column keeps its unique constraint as the backstop, as the existing doc comment insists.

### 4.2 One settled quantity, driving both valuation and outstanding

A purchase line knows only `qty_ordered` and `total_amount` (D6). Define, all net of reversals:

```
accepted(line)      = Σ goods_receipt_items.qty_accepted
rejectedTotal(line) = Σ defect_movements.qty  where type = 'reject'
returnedOut(line)   = Σ |defect_movements.qty| where type = 'return_out'
disposed(line)      = Σ |defect_movements.qty| where type = 'dispose'

qtySettled(line)  = accepted + rejectedTotal − returnedOut          (D16)
outstanding(line) = qty_ordered − qtySettled
stillHeld(line)   = rejectedTotal − returnedOut − disposed          (≥ 0, enforced)
```

Each arrival's value is a **cumulative-rounding slice** over `qtySettled`:

```
sliceValue(totalAmount, qtyOrdered, settledBefore, qtyArrivingNow) =
    roundHalfUp(totalAmount * (settledBefore + qtyArrivingNow) / qtyOrdered)
  - roundHalfUp(totalAmount *  settledBefore                   / qtyOrdered)
```

where `qtyArrivingNow = qty_accepted + qty_rejected` for the line, split between the two ledgers in
proportion to those two numbers (accepted part → the sellable ledger, rejected part → the defect
ledger), again by cumulative rounding so the two parts sum to exactly the slice.

Why this shape, concretely — 10 yards ordered for Rp 1.000.000:

| Step | accepted | rejectedTotal | returnedOut | qtySettled | outstanding | status |
|---|---|---|---|---|---|---|
| Receipt 1: 8 good, 2 defective | 8 | 2 | 0 | 10 | 0 | `partially_received` |
| Return the 2 to the supplier | 8 | 2 | 2 | 8 | **2** | `partially_received` |
| Replacement receipt: 2 good | 10 | 2 | 2 | 10 | 0 | `received` |

The return re-opens exactly the room its replacement needs, so the replacement is **not**
over-receipt (D17) and the document can genuinely reach fully received (D15). Had she instead
released the 2 by lelang or hibah, `qtySettled` would stay 10, `outstanding` 0, `accepted` 8, and
she short-closes.

Properties, all required and all unit-testable: every slice is non-negative; the slices of a fully
settled line sum to **exactly** `total_amount` with no stranded rupiah; nothing needs to know
whether it is the last receipt; a short-closed line is valued at exactly what arrived. This is the
same shape as `valueDeltaForConsumption`'s zero-residual rule, which exists for exactly this class
of bug.

Computed in **integer-scaled arithmetic** (qty in centi-units, half-up on integers), never float
multiplication — the schema already warns that `0.35 * 10` is `3.4999999999999996` in IEEE 754,
which is why `production_batch_costs.total` is a generated column.

An accepted arrival stays `type='purchase'` on the raw-material ledger and remains the only
movement type that moves the sellable moving average. **Partial receipts make that average more
accurate, not less**: a purchase at a new price now moves it as goods actually arrive. And because
rejected units are valued into the *defect* pool instead, **rejects never pollute the sellable
average that feeds HPP** — the single most important consequence of D14.

`return_out` and `dispose` are outflows from the defect pool, valued through
`valueDeltaForConsumption` at the defect pool's own average — so when an item's defect balance
returns to 0 its defect value is exactly 0, with any rounding residual absorbed by the movement
that zeroes it. A `dispose` row's `proceeds_amount` plays no part in that valuation: the ledger
records what *cost* left the pool, and the proceeds are separate cash (D24). The per-document
figures in §4.3 are read from that document's own rows' `value_amount`/`proceeds_amount` (exact per
row); only the *pooled* defect balance averages across documents, which is what moving average
means everywhere else in this system.

For a **production** receipt, both the accepted and the rejected units are valued at the batch
line's frozen `unit_cost_amount` — they cost the same to make.

### 4.3 HPP, defects, replacements, and what the document shows

**HPP/pcs is never rewritten** (D20). It is computed at posting over planned pcs, exactly as
today, and the row is frozen by a trigger — the same locking rule `order_items.unit_cost` already
follows. What changes is what the document *reports*.

Batch of 10 pcs, posted HPP/pcs = **H**, total cost **C = 10H**:

| Outcome | Sellable | Defect | Absorbed | Reported |
|---|---|---|---|---|
| Receipt: 8 good, 2 defective | 8 × H | 2 × H | all of C | HPP/pcs = H. Nothing lost yet — the cost is simply sitting in defect stock. |
| …then the tailor exchanges the 2 | 10 × H | 0 | all of C | HPP/pcs = H, **correct**: the tailor bore the rework. |
| …or the 2 are released by **hibah** (Rp 0) | 8 × H | 0 | C, of which 2H is a net loss | HPP/pcs still H, plus **"HPP riil per pcs"** = C / 8 = 1,25 H and **"Kerugian bersih barang cacat"** = 2H. |
| …or the 2 are released by **lelang** for P | 8 × H | 0 | C, of which 2H − P is a net loss | HPP/pcs still H, plus **"HPP riil per pcs"** = (C − P) / 8 and **"Kerugian bersih barang cacat"** = 2H − P. |
| 2 pcs never arrive at all (short-closed) | 8 × H | 0 | 8H | **"Nilai belum terserap"** = 2H — cost that never became inventory. |

**The variance figures are always net of proceeds** (D20/D24):
`HPP riil per pcs = (total batch cost − proceeds) / pcs accepted into sellable stock`, and
`Kerugian bersih = defect value released − proceeds`. The hibah row is just the lelang row with
P = 0, so there is one formula, not two. Net loss can in principle come out negative (defects
auctioned above their carried cost); that is a gain and is displayed as such rather than clamped
to zero.

So: with defects valued (§4.2), *everything that arrived in some form is absorbed*, and
"Nilai belum terserap" now means only "never arrived at all" — which is exactly what the owner
needs to see. Material average cost is untouched by production defects (materials were consumed at
posting, before any of this).

For a purchase document the same panel reads: **Total pesanan**, **Nilai diterima** (into sellable),
**Nilai cacat** (still held), **Nilai ditukar**, **Nilai cacat dilepas**, **Hasil pelepasan**
(proceeds, Rp 0 for hibah), **Kerugian bersih**, **Nilai belum terserap**. All read-only, all gated
by `finance.view_profit` through the existing pattern (render the Server Component conditionally so
the query never runs for a session without the key).

---

## 5. Transaction shapes (CLAUDE.md atomicity)

Shared lock order everywhere below, so nothing can deadlock against anything else here: **source
document row first, then item rows in sorted order** (fabrics then accessories by id; SKUs by
sku) — the same order `postBatch` and `saveStockCount` already establish. Defect writes lock the
*same* item rows the sellable path locks (`lockVariantForUpdate` / `lockFabricForUpdate` /
`lockAccessoryForUpdate`), which conveniently serializes a defect write against a concurrent
sellable write for the same item.

**`postGoodsReceiptForPurchase(purchaseId, lines, actor)`** — one transaction:

1. `SELECT ... FOR UPDATE` the `purchases` row **first**. Serializes two people receiving the same
   purchase from two phones; the second blocks, then re-reads and either posts the remainder or
   fails cleanly.
2. Reject unless `status in ('ordered','partially_received')`.
3. Recompute `qtySettled`/`outstanding` per line **inside** the lock. Reject over-receipt
   (`accepted_now + rejected_now > outstanding`) with an Indonesian message naming the line and
   the remaining quantity (D17), and reject a receipt whose every line is zero.
4. Lock each affected `fabrics`/`accessories` row in sorted id order.
5. Insert `goods_receipts` + `goods_receipt_items`.
6. Per line: the accepted part → one ledger movement (`type='purchase'`,
   `ref_type='goods_receipt'`, `ref_id = goods_receipt_item.id`, `qty = +qty_accepted`,
   `value_amount` = its share of the §4.2 slice, `purchased_at = received_at`, `supplier_id` +
   `supplier` name snapshot). The rejected part → one `defect_movements` row (`type='reject'`,
   `goods_receipt_item_id`, the source line, `value_amount` = the rest of the slice).
7. Recompute `status` (`received` when every line's `accepted = qty_ordered`, else
   `partially_received`) and update it.
8. One `audit_log` entry for the whole receipt (`entityType: 'goods_receipt'`, `action: 'receive'`).

**`postGoodsReceiptForBatch(batchId, lines, actor)`** — identical shape: lock the
`production_batches` row first, require `status='posted'` and
`receipt_status in ('pending','partially_received')`, lock `product_variants` rows in sorted SKU
order, write one `stock_movements` row per accepted part (`type='production'`,
`ref_type='goods_receipt_item'`, `value = qty × line.unit_cost_amount`) and one `defect_movements`
row per rejected part at the same unit cost. Updates `receipt_status`, not `status` (D5).

**`reverseGoodsReceipt(receiptId, actor)`** — mirrors `voidAccessoryPurchase`:

1. Lock the parent document row, then the item rows in sorted order.
2. Reject if already reversed, or if it is itself a reversal.
3. Reject if any **later** movement exists for an affected item — for raw materials the existing
   "no consumption/adjustment/void after this purchase" rule applies unchanged (you cannot
   un-receive fabric a batch has already cut); for finished goods, reject if the SKU's balance
   would go negative; **and** reject if any of this receipt's defect rows have since been returned
   or released (reversing "through" a disposition would retroactively invalidate its recorded
   value, exactly the case the existing void rule exists to prevent). Each rejection points at the
   alternative: "Sesuaikan stok" for sellable, "Batalkan pengembalian atau pelepasan dulu" for
   defects.
4. Insert a `kind='reversal'` receipt whose items are the exact negation, the exact reversing
   ledger rows (`purchase_void` with `voids_movement_id` on raw materials; a negated `production`
   row on the append-only `stock_movements`; a `type='reversal'` row on `defect_movements`), stamp
   `reversed_at`/`reversed_by_staff_user_id` on the originals, recompute the document's status,
   write one audit entry.

**`returnDefectsToSupplier(sourceLineId, qty, reason, actor)`** (`inventory.manage`) — lock the
document row, then the item row; require `qty ≤ stillHeld(line)`; insert one `defect_movements`
row (`type='return_out'`, `qty` negative, `value_amount` via `valueDeltaForConsumption` on the
defect pool); recompute `qtySettled`/`outstanding`/status — **and if the document was `closed` or
`cancelled`, re-open it to `partially_received`**, stamping the reopen columns (D18); one audit
entry.

**`disposeDefects({ sourceLineId, qty, disposalType, proceedsAmount, note, occurredAt }, actor)`**
(`inventory.manage`, D24) — same shape as the return above: lock the document row, then the item
row; require `qty ≤ stillHeld(line)`, a non-blank `note`, and `proceedsAmount > 0` for `auction` /
`= 0` for `donation` (validated in the action's Zod schema *and* re-checked server-side, with the
DB CHECKs as the backstop); insert one `defect_movements` row (`type='dispose'`, `qty` negative,
`value_amount` via `valueDeltaForConsumption` on the defect pool, plus `disposal_type` and
`proceeds_amount`); **no** change to `qtySettled`, `outstanding` or status — releasing is the owner
accepting the shortfall, not creating room for a replacement; one audit entry recording the
proceeds. No journal entry is written anywhere (D24).

**`reverseDefectMovement(movementId, actor)`** (`inventory.manage`) — the same exact-negation rule
for a single `return_out`/`dispose`/`reject`, rejected if a later movement for that item would be
invalidated or if the defect balance would go negative. A reversal of a `dispose` row also negates
its `proceeds_amount`, so the net-loss figures in §4.3 stay correct without a special case.
Re-closes nothing automatically; a re-opened document is closed again through the normal close
action.

**`closePurchaseShort` / `closeBatchShort`** (D19) — lock the row, require a non-terminal status
and a `close_reason`, set `cancelled` when `accepted = 0 and rejectedTotal = 0` else `closed`,
audit log. No stock movement, no cost adjustment, and no effect on defects already held (they stay
in the defect pool until returned or released).

**`postBatch` change** (D4) — delete the finished-goods `stock_movements` insert (step 9 of its
current doc comment); everything else stays. Its doc comment and the
`stock_movements.valueAmount` comment in `packages/db/src/schema/catalog.ts` both need rewriting
to say a `production` movement now originates from a goods receipt.

---

## 6. What else moves, and what deliberately does not

| Area | Effect |
|---|---|
| **Sellable stock ledger** | One new inflow path (receipt). Sale/return/adjustment/stock-count untouched. After this change every `stock_movements` row with `type='production'` has `ref_type='goods_receipt_item'`; the old `'production_batch_item'` rows stay valid history, so `listStockLedger`'s "link to the batch" join must handle **both** (resolving new rows through `goods_receipt_items → production_batch_items`). |
| **Defect stock** | Structurally cannot leak into sellable stock, orders, packing or the storefront — it is a different table, so no existing query needs a new `WHERE` (D14). The only places that must *deliberately* read it are the stock pages, the source documents, and the `/stock/defects` view (§7). |
| **Stock count (Hitung stok)** | Unchanged mechanically, but it gains two real traps, both handled in the UI and both landing in **S4**, the session that creates the risk: (a) goods physically in the house but not yet received read as missing, and a recount would "correct" them into existence as an adjustment, permanently detaching them from their batch and its HPP → the page warns, listing that product's posted-but-unreceived batches with a link; (b) the defect bin is physically in the same house → the standing instruction "Jangan hitung barang cacat, hitung hanya barang yang bisa dijual" ships in S4 as copy, and each SKU's read-only defect quantity is added in S5 once there is a ledger to read it from. |
| **Orders / packing** | Unchanged. Received quantity is immediately sellable (D22); unreceived quantity simply isn't in stock, so `decrementStockForOrderItems`' existing "stok tidak cukup" error already covers it. Packing never touched stock. |
| **Storefront (apps/web)** | `available = SUM(qty) > 0` unchanged, but a product now goes available only once output is received, not at posting. Intended. No code change. |
| **Overview dashboard** | Reads `stock_movements`; unchanged. Defect stock and disposal proceeds are deliberately *not* added to any SPEC §6 metric in this plan (D26). |
| **Legacy purchases** | Not migrated (D11); still visible on `/stock/fabrics/[id]` and `/stock/accessories/[id]`. `voidFabricPurchase`/`voidAccessoryPurchase` must **refuse** a movement with `ref_type='goods_receipt'` and point at "Batalkan penerimaan" — otherwise there would be two ways to reverse the same thing, one bypassing the receipt document. |
| **Existing posted batches** | Migration 0025 backfills `receipt_status='received'` where `status='posted'` (idempotent: `AND receipt_status='pending'`). Their stock already exists, so the UI never offers a receipt for them and nothing is double counted. The column default (`'pending'`) is what makes every *future* post start unreceived. |
| **Rollback safety** | Every migration is additive: new tables, nullable or defaulted columns, widened CHECK/index predicates. No existing constraint is ever tightened, and no existing column changes meaning. `production_batches.status` keeps its old domain, so the previous release still reads and writes it correctly against the new schema — which is the one release where this matters. |
| **`seed.ts`** | Stays insert-only. `SUPPLIER_KINDS`, `PURCHASE_STATUSES`, `PRODUCTION_RECEIPT_STATUSES`, `DEFECT_ITEM_KINDS`, `DEFECT_MOVEMENT_TYPES`, `DEFECT_DISPOSAL_TYPES` are code constants backing CHECK constraints, not rows — nothing to seed. The one new permission row (`inventory.receive`) ships **in a migration** with `ON CONFLICT DO NOTHING` + grants to `super_admin`/`owner`, per CLAUDE.md and migration 0012's pattern. `seed-dev.ts` may gain a couple of demo suppliers (dev/demo data is what it is for). |

---

## 7. Admin UI

Indonesian copy, English routes, no em dashes in UI text. Every list page renders both layouts
(`CardList` for phones, `TableContainer` for tablet/desktop) and every list e2e test asserts at
390px **and** the 1280px default.

**`/suppliers`** (new, group "Data Master"; `inventory.view` to read, `inventory.manage` to write) —
list with search + Semua/Aktif/Nonaktif `FilterTabs` + pagination, mirroring `/accessories`
exactly. `/suppliers/new` and `/suppliers/[id]` (detail + edit + Aktif switch) mirror
`AccessoryForm`, with only **Nama** marked required (D13) and the **"Batal"** secondary button
next to "Simpan" on the create form (commit dd3b906). Detail also lists that supplier's purchases
and the cost components defaulting to it.

**`/purchases`** — becomes the document list: `purchase_no`, supplier, `ordered_at`, item count,
status badge, total (`finance.view_profit`-gated through the existing `stripPurchaseAmount`
discipline). `FilterTabs` over the five statuses. The current UNION-over-two-ledgers query is
replaced; its `stripPurchaseAmount(s)` helpers are kept and reused.

**`/purchases/new`** — supplier picker (required, searchable, matching `kinds` sorted first),
`ordered_at`, notes, and repeatable item rows (`+ Tambah item`): type → item → qty → total paid,
with the live `≈ Rp X/yard (otomatis)` hint the current form already shows. "Batal" + "Simpan".

**`/purchases/[id]`** — header (supplier as a link, status badge, a "Dibuka kembali" badge when
re-opened), a line table showing **Dipesan / Diterima / Cacat / Ditukar / Dilepas / Sisa**, the
read-only value panel from §4.3, a receipt history, a defect history (each row showing its type,
quantity, proceeds and notes), and the actions: "Terima barang" (`inventory.receive`); "Tutup
pesanan" (`inventory.manage`, required reason); "Kembalikan ke pemasok" and "Pelepasan barang
cacat" per line (`inventory.manage`); "Batalkan penerimaan" per receipt and "Batalkan" per defect
movement (`inventory.manage`). Header/line editing is allowed only while no receipt exists (D7),
enforced server-side and not merely by hiding the button.

**Disposal form** (`inventory.manage`, D24) — a small dialog on the defect line: quantity (capped
at *stok cacat tersedia*), **Jenis pelepasan** as two radio options "Lelang" / "Hibah", a
**"Hasil lelang"** rupiah input shown and required only for Lelang (hidden and forced to Rp 0 for
Hibah), **Tanggal** (defaults today, backdatable), and required **Catatan**. The form shows the
defect value being released and the resulting **Kerugian bersih** live as the proceeds are typed,
so the owner sees the consequence before saving.

**Receipt form** (one shared client component, both sources) — `received_at` (defaults today),
optional "Diterima oleh", note, and one row per outstanding line prefilled with the **remaining**
quantity, plus a **"Ditolak (cacat)"** quantity per row with an inline hint that defects go to
defect stock and can be exchanged or released later. Client-side it blocks
`diterima + ditolak > sisa` before submitting, and the server re-checks it (D17). Mobile-first
single column — this is a page the wife uses standing next to a box.

**`/production/[id]`** — a posted batch gains a "Hasil produksi" panel with the same per-line
table and the same actions, plus the §4.3 variance lines inside the existing
`finance.view_profit`-gated `BatchCostsSection`.

**Defect stock visibility** — reuse the existing structure rather than inventing one:
- a "Cacat" column on `/stock`, `/stock/fabrics`, `/stock/accessories`;
- a "Stok cacat" figure plus a defect-ledger section on `/stock/[sku]`, `/stock/fabrics/[id]`,
  `/stock/accessories/[id]`, each row linking back to its source document and showing proceeds on
  a `dispose` row (value and proceeds columns gated by `finance.view_profit`, quantity always
  visible — the same split `/accessories` already applies to its own `valueAmount`);
- a fourth **"Cacat"** tab in `StockTypeTabs` → `/stock/defects`, listing every item with a
  non-zero defect balance across all three kinds. That component already takes
  `canViewFinishedGoods`/`canViewRawMaterials` for exactly this two-key split, so the tab renders
  only what the session can follow and each section of the page is gated by its own key
  (`stock.view` / `inventory.view`); page-level gate is either.

**`/receipts`** (new, group Operasional, `inventory.view`) — all receipts newest first, both
sources, link back to the source document, "Dibatalkan" badge on reversed ones.

**`/production/cost-components/new` + `/[id]`** — optional "Pemasok/penjahit default" picker. The
batch form's extra-cost rows get a per-line supplier select prefilled from that default (D9),
editable while the batch is a draft.

**Nav** — rename group "Katalog" → "Data Master", add Pemasok (icon `Truck`), add Penerimaan (icon
`ClipboardCheck`; `PackageCheck` is already Packing) under Operasional.

---

## 8. Sessions

Seven sessions. Each one is independently shippable — no session leaves a half-wired feature
behind — and each ends with: related unit tests green, `pnpm typecheck && pnpm lint && pnpm build`,
the matching `/code-review` reviewers, and no commit by the agent. TDD is **required** throughout:
receipts and defects are stock (CLAUDE.md §Workflow 2).

**S1 — Supplier master. Migration 0022** (`suppliers`).
`lib/suppliers/queries.ts` (list/get/create/update/setActive + audit log, mirroring the master half
of `lib/inventory/accessories.ts`). `/suppliers` list/new/detail-edit. Nav group rename + Pemasok.
*Unit:* citext uniqueness collision, deactivate-not-delete, `kinds` subset/duplicate rejection,
name-only creation succeeds with every other field blank. *E2E* `suppliers.spec.ts`: create with
only a name → visible at 390px **and** 1280px → edit adding bank details → deactivate → filter
tabs.

**S2 — Supplier on cost components and batch cost lines. Migration 0023.**
Picker on the cost-component form; per-line picker on the batch form prefilled from the default;
supplier shown in the posted cost breakdown. *Unit:* the snapshot is frozen on insert and survives
a later supplier rename; a per-line override beats the master default; an inactive supplier cannot
be chosen for a **new** line but keeps working on an existing one (the rule `syncExtraCostLines`
already applies to components). *E2E:* extend `production-and-stock.spec.ts`.

**S3 — Purchase documents + purchase receipts (accepted quantities only). Migration 0024**
(`purchases`, `purchase_items`, `goods_receipts`, `goods_receipt_items`, the freeze trigger, the
two ref-type CHECK widenings, `supplier_id` + the receipt unique index on both raw-material
ledgers, the `inventory.receive` permission row + grants).
`lib/documents/document-number.ts`, `lib/purchases/*` (create/edit/close/cancel), `lib/receipts/*`
(`postGoodsReceiptForPurchase`, `reverseGoodsReceipt`), the §4.2 slice helper. `/purchases` list,
new and detail are replaced **in this session**, so there is never a window with two purchase
models live; the legacy void path starts refusing receipt-backed movements. No reject field yet —
defective goods are simply not accepted, which is strictly better than today (where there is no
reject concept at all).
*Unit:* the §4.2 valuation (exactness at full receipt across several partials, a rounding-boundary
total, a short-close), over-receipt rejected, receipt against a closed document rejected, status
recomputation for every transition, reversal allowed when nothing followed and rejected once a
batch consumed the material, double reversal rejected, the freeze trigger, cost stripping without
`finance.view_profit`. *E2E* `purchases-receipt.spec.ts` at both viewports: 2-line purchase →
receive part → stock rose by exactly the accepted quantity → receive the rest → `received` →
reverse → stock back.

**S4 — Production output receipts. Migration 0025** (`receipt_status` + close columns + the
backfill of existing posted batches; widened `stock_movements_type_ref_unique_idx`).
`postBatch` stops writing finished-goods stock; `postGoodsReceiptForBatch`; the "Hasil produksi"
panel and "Tutup batch". **Also the stock-count guard, pulled forward from S7** because this is
the session that creates the risk: `/stock/count/[productId]` warns when the product has
posted-but-unreceived batches, listing them with a link, and carries the standing instruction
"Jangan hitung barang cacat, hitung hanya barang yang bisa dijual" (the per-SKU defect quantity
itself arrives in S5, when there is a ledger to read).
*Unit:* posting consumes material and writes **no** `stock_movements` row; a receipt writes exactly
`qty × unit_cost`; partial then full; over-receipt rejected; reversal; short-close leaves HPP frozen
and reports "Nilai belum terserap"; the backfill is idempotent and leaves pre-existing posted
batches at `received` with no extra movement; the count page's warning appears for a
posted-unreceived batch and not otherwise. *E2E:* extend `production-and-stock.spec.ts` — its
step 9 currently asserts stock rose at posting, and that assertion moves to after the receipt;
assert the count-page warning at both viewports.

**S5 — Defect ledger + rejects at receipt (both sources). Migration 0026** (`defect_movements`,
its immutability trigger, `goods_receipt_items.qty_rejected`, `unique(production_batch_items.id,
sku)` and the two `purchase_items` composite-FK targets).
`lib/defects/*` (balance per item, ledger listing, the reject write), the §4.2 split of a slice
between the sellable and defect ledgers, the `qtySettled`/`outstanding` change in both receipt
paths, the "Ditolak (cacat)" field on the receipt form, and all the read-only defect visibility
(the three list columns, the three detail sections, `/stock/defects`, the per-document defect
history, and the per-SKU defect quantity on the stock-count page whose instruction copy S4 already
shipped).
*Unit:* a reject never touches the sellable balance or the sellable moving average; accepted +
rejected both consume `outstanding`, so a fully-arrived-but-partly-defective line blocks further
receipts; over-receipt counting accepted **and** rejected together is rejected (D17); the slice
splits exactly between the two ledgers with no stranded rupiah; defect balance never goes negative;
the immutability trigger; the 1:1 `qty_rejected` ⇔ `reject`-movement invariant; production rejects
value at the frozen unit cost. *E2E:* extend `purchases-receipt.spec.ts` and
`production-and-stock.spec.ts` — receive with a reject, assert sellable stock rose by the accepted
quantity only, assert the defect figure appears on the item page and on `/stock/defects` at both
viewports, and assert the SKU cannot be oversold against its defect quantity.

**S6 — Defect dispositions: exchange and release. Migration 0027** — the smallest of the six:
reopen columns (`reopened_at`, `reopened_by_staff_user_id`, `reopen_reason`) on `purchases` and
`production_batches`, and nothing else. The disposal columns already shipped with the table in
0026 (§3.5).
`returnDefectsToSupplier`, `disposeDefects`, `reverseDefectMovement`, the re-open-on-return rule
(D18), the disposal dialog (§7), and the §4.3 value/variance panels on both document types.
*Unit:* a return re-opens exactly its own quantity of `outstanding` and a replacement receipt then
completes the document (the §4.2 worked example, end to end); a return against a closed document
re-opens it and stamps the reopen columns; a release does **not** create outstanding; `auction`
requires proceeds > 0 and `donation` forces exactly 0; a release requires non-blank notes; neither
disposition can exceed `stillHeld`; reversal of each disposition, including that a reversed release
negates its proceeds so the net-loss figures return to their prior values; a receipt reversal is
rejected once its defects have been returned or released; the defect pool's value is exactly 0 when
its quantity reaches 0; and the variance figures ("HPP riil per pcs" = (C − proceeds) / sellable
pcs, "Kerugian bersih barang cacat", "Nilai belum terserap") against hand-computed numbers for both
a lelang and a hibah. *E2E:* the exchange round trip (receive with reject → return → replacement
receipt → `received`), the lelang path (release with proceeds → short-close → net loss and proceeds
shown), and the hibah path (Rp 0, proceeds input hidden), all at both viewports.

**S7 — Cross-cutting polish and the review sweep.**
`/receipts` list; `listStockLedger`'s dual ref-type batch link; doc comments rewritten on
`stock_movements.valueAmount`, `postBatch` and
`accessory_movements`; `docs/SPEC.md` §5.1/§5.2 updated with the new tables, the "stock only moves
on receipt" rule, defect stock, and a one-line note that disposal proceeds are stored for a future
accounting module but booked nowhere today; `CLAUDE.md` touched only if a rule there needs it. Full reviewer
pass (`database-reviewer`, `typescript-reviewer`, `react-reviewer`, `security-reviewer`,
`silent-failure-hunter`) + full unit + e2e run.

**Migration numbering:** 0022 → 0023 → 0024 → 0025 → 0026 → 0027, one per session S1–S6, each
additive and each reviewed on its own (`drizzle-kit generate`, then **read** the file, per
CLAUDE.md). If sessions are reordered, renumber — nothing in the plan depends on a specific number.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| S3 and S5 are the big ones (4 tables + a trigger + a permission + the `/purchases` rewrite; then a 5th table + a cross-cutting read model). | Both migrations are additive and nothing reads the new tables until the lib/UI lands, so each can be generated, read and reviewed on its own first. If S5 still feels too large at the time, split the *read* surface (the three list columns, three detail sections and `/stock/defects`) into S5b — but never split "rejects can be recorded" from "rejects are visible somewhere". |
| "Stock no longer moves at posting" is a behaviour change the wife feels immediately. | Land S3 and S4 close together and tell her before S4 ships: after posting, output must be received before it can be sold or counted. The stock-count warning now ships **inside S4** (owner decision), not S7, so the safety net lands in the same session as the risk. |
| Defect stock could be silently counted as sellable somewhere. | Structural, not vigilance: a separate table means no existing query can see it (D14). The e2e assertion that a SKU cannot be oversold against its defect quantity (S5) is the regression guard. |
| The §4.2 slice rounding is exactly the class of bug this repo has already been bitten by twice. | A pure, exported helper with integer-scaled math and its own test file, including the accepted/rejected split; no float multiplication anywhere in the path. |
| Re-opening a closed document weakens a status people treat as final. | Only one action can do it (a return-to-supplier, which is itself the reason outstanding exists again), it needs `inventory.manage` and a reason, it is audit-logged, and the document carries a visible "Dibuka kembali" badge. |
| Disposal proceeds are stored but booked nowhere, so they can look like untracked cash. | Deliberate (D24): no accounting module exists to book them into. They are visible on the source document and the defect ledger, they feed the net-loss figures, and they are audit-logged with the actor — enough to reconcile by hand until a double-entry module exists. S7 records this explicitly in SPEC so it is a known gap, not a surprise. |
| Widening a partial unique index and three CHECK constraints each need drop+create. | All read and verified against the real local Postgres before committing; none touches existing rows, and each new predicate is a strict superset of the old one, so every existing row stays valid. The close pair check is written one-directional from the start (§3.2), so no later migration has to loosen it. |
| `fabrics.supplier` (free text) now coexists with `suppliers`. | Left alone — it is a reference label on the fabric master, not a transaction. Converting it to an FK is a separate, optional follow-up. Note for whoever does it: `packages/db/test/storefront-queries.test.ts`'s cost-leak denylist includes `"supplier"`, so a new `supplierId` on `fabrics` must stay out of every storefront query. |

---

## 10. Still open (one question, with a recommendation)

Round 1's Q1–Q9 and round 2's N1–N5 are all answered and now live in §2 as D1–D28. One question
remains, and it does not block starting S1 — it only needs answering before **S6**.

**N-new-1 — Is a third disposal type, "Dibuang/Dimusnahkan" (discarded, Rp 0), also needed?**
The owner named only two (Lelang, Hibah). *Recommend:* **yes, add it in S6 alongside the other
two.** Hibah and Dibuang are both Rp 0 but mean completely different things, and the difference is
one the owner will care about later: a donation is a deliberate giveaway worth being able to show
(and potentially relevant to zakat/CSR records), while discarding is pure waste that belongs in a
waste figure. Folding waste into "Hibah" would mislabel it permanently in the only record that
exists, and there will realistically be unsellable fabric offcuts and ruined pieces that simply go
in the bin. The cost of adding it is essentially zero *because* of the shape chosen in §3.5: all
disposal types route through one `dispose` movement type carrying `disposal_type` +
`proceeds_amount`, so a third kind is one array value, one radio option, and one extra CHECK branch
(`donation` and `discarded` share the `proceeds_amount = 0` rule) — no new code path, no migration
beyond the CHECK, and nothing in §4.2/§4.3 changes. Equally, if the owner is confident everything
unsellable gets donated rather than binned, dropping it costs nothing either — which is exactly why
this is worth one explicit yes/no rather than a guess.
