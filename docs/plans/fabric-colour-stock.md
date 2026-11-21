# Plan: Fabric stock per colour (Pembelian, Penerimaan, Stok, Produksi)

Status (2026-11-21): **Approved** (owner decisions in §10). S1 (schema) implemented and reviewed
(database-reviewer, typescript-reviewer), awaiting commit. S1 notes: migration 0046; per-bucket
reads `getFabricColorBalance` / `listFabricColorBalances` in `lib/inventory/fabric-stock.ts`; both
void paths (`reverseGoodsReceipt`, `voidFabricPurchase`) already copy `fabric_color_id` so S1 is a
safe rollback target for S3+ (§3); nothing writes a colour yet. S2 (purchase lines per colour)
committed. S3 (receipts, undo, defects, exchange, release per colour) implemented, awaiting review
and commit: receipts write the line's colour; `reverseGoodsReceipt`'s later-movement block and
negative backstop are per bucket; defect colour is joined from the purchase line
(`getFabricDefectQtyByColor`, `listDefectStockMaterials().colors`); audit entries carry
`lines[]`/`line` with `fabricColorId` + `colorName`. Until S4/S5, adjustments and production still
write "Tanpa warna", so the e2e proves the same-colour undo block with a same-colour receipt
reversal; unit tests cover production/adjustment rows. S3 committed. S4 (stock pages + adjustment
per colour) implemented, awaiting commit: `recordFabricAdjustment` takes `fabricColorId` and checks
and values the bucket (`isAdjustableBucket`: active colour always; inactive colour or Tanpa warna
only while that bucket is non-zero, Tanpa warna also when the fabric has no active colour; no
bucket may go below zero); `listFabricColorBalancesByFabric` feeds the `/stock/fabrics` chips;
`listFabricStockLedger` has colour per row and a `?warna=<id>|tanpa` filter (running balance of
the filtered bucket); the cards/total on `/fabrics/[id]` and `/stock/fabrics/[id]` replace the old
single headline. The e2e drives the same-colour adjustment blocking undo through the UI.

The owner buys fabric per colour, with a different yardage (and sometimes a different price per
yard) for each colour. Example: PO-202611-001 at JMS Textile, Marbella Anti UV in 6 colours, 838
yard total, Rp 19.500/yard. Today a purchase line, the fabric ledger and production consumption
know only the **fabric**, never the colour, so "how many yards of Sage do we have?" cannot be
answered.

Goal: colour flows from purchase line to receipt to stock to production consumption, using the
fabric colours already kept in master data (`/fabrics/[id]` → "Warna"). Old data without a colour
stays valid as **"Tanpa warna"**. Admin only; the storefront is untouched.

---

## 1. What exists today (verified against the code)

### 1.1 Schema (`packages/db/src/schema/catalog.ts`)

| Table | Colour today? | Notes |
|---|---|---|
| `fabrics` | – | Master. Reference price `price_amount`/`price_unit`. |
| `fabric_colors` | **is the colour** | `fabric_id`, `name` (citext, unique per fabric), `supplier_color_code`, `hex`, `is_active`. Has `unique (id, fabric_id)` as a composite FK target already. Hard delete allowed only while unreferenced (`deleteFabricColor`, FK violation → generic message); otherwise deactivate. |
| `product_variants` | **yes** `fabric_color_id` | Composite FK `(fabric_color_id, fabric_id)` → `fabric_colors(id, fabric_id)`. **Every SKU already maps to exactly one colour of its product's fabric.** This is the "variant colour → fabric colour" mapping; it always exists. |
| `product_images` | yes | Photo grouping only. |
| `purchase_items` | no | `item_type` fabric/accessory, `fabric_id` or `accessory_id`, `qty_ordered` numeric(10,2), `total_amount` (ongkir included, D6, no unit price stored). Partial unique `(purchase_id, fabric_id)` → a fabric can appear only once per PO. Trigger `prevent_received_purchase_item_change` (0024) freezes a received line; its `WHEN` clause names `qty_ordered, total_amount, item_type, fabric_id, accessory_id` explicitly. |
| `goods_receipts` / `goods_receipt_items` | no (via line) | Item points at `purchase_item_id`; `qty_accepted`, `qty_rejected`. Reversal = exact negation. |
| `fabric_stock_movements` | no | Ledger: `qty` numeric(10,2) yards, `value_amount`, `type` purchase/purchase_void/production/adjustment, `ref_type` goods_receipt/production_batch/manual. Balance = SUM(qty), value = SUM(value), moving average derived. Immutable by trigger `prevent_fabric_stock_movement_mutation` (0008: compares `to_jsonb(NEW)` minus the void columns, so a **new column is automatically frozen too**). |
| `defect_movements` | no (via line) | `item_kind='fabric'` rows always carry `purchase_item_id` (composite FK `(purchase_item_id, fabric_id)` → `purchase_items`). So a fabric defect's colour is derivable from its purchase line by join, no new column needed. |
| `production_batches` | no | One `fabric_id` per batch; `fabric_yards` (batch total), `fabric_cost_amount` (computed at posting). Frozen once posted (0007/0008 triggers). |
| `production_batch_items` | indirectly | SKU → variant → `fabric_color_id`. One batch may hold several colours (2 of 2 posted batches on the local dev DB do). |
| `supplier_payments` | – | Per purchase document (`purchase_id`), not per line. Tagihan derived from line totals (`purchaseLineTagihanSql`). |

### 1.2 Code paths

- **Fabric master + colours:** `lib/products/fabric-queries.ts`, `app/(shell)/fabrics/**`
  (`fabric-colors-section.tsx`). `/fabrics/[id]` shows one total balance (`getFabricBalance`) when
  the session has `inventory.view`.
- **Purchase documents:** `lib/purchases/queries.ts` (`createPurchase`, `updatePurchase`: lines
  replaced as a set, only while `ordered` with no receipt; `validateLines` dedups by
  `itemType:itemId`; `assertItemsOrderable`; `getPurchaseDocument`). Form:
  `purchases/_components/purchase-form.tsx` (Jenis, Bahan/Aksesoris, Jumlah, Total harga, "≈ Rp
  X/yard (otomatis)" hint only).
- **Receiving:** `lib/receipts/queries.ts` `postGoodsReceiptForPurchase` (lock PO → over-receipt
  check per line → lock items fabrics-then-accessories by id → value the slice
  (`receipts/valuation.ts`) → accepted part as one `purchase` row on `fabric_stock_movements`
  (ref = receipt item), rejected part as a `reject` row via `insertRejectMovements`).
  `reverseGoodsReceipt` blocks if a later production/adjustment/void exists **for the same fabric**
  (`hasLaterBlockingMovement`), writes exact `purchase_void` rows. Form: `receive-form.tsx`.
- **Defects / exchange / release:** `lib/defects/queries.ts` (rejects, balances
  `getDefectQtyByFabric`, `listDefectStockMaterials`), `lib/defects/dispositions.ts`
  (`returnDefectsToSupplier` = "Ditukar", re-opens the PO so the replacement is received against
  **the same line**; `disposeDefects` = "Dilepas" lelang/hibah/dibuang; `reverseDefectMovement`).
  All keyed per purchase line. Defect pool is valued per fabric (D23).
- **Fabric stock:** `lib/inventory/fabric-stock.ts` (`listFabricsWithBalance`, `getFabricBalance`,
  `listFabricStockLedger`, legacy `recordFabricPurchase`/`voidFabricPurchase`,
  `recordFabricAdjustment`). Pages `/stock/fabrics`, `/stock/fabrics/[id]`, `adjust-fabric-dialog.tsx`.
  Legacy manual purchases list: `lib/inventory/purchases.ts`, `/purchases/legacy`.
- **Production + HPP:** `lib/production/queries.ts` `postBatch`: lock batch → lock fabric → one
  balance check `fabric_yards ≤ fabric balance` → one `production` movement valued with
  `valueDeltaForConsumption(balance, -yards)` (moving average, zero-residual rule,
  `packages/commerce/src/inventory/moving-average.ts`) → `fabric_cost_amount` → `unit_cost =
  ceil(total / pcs)` frozen on every line. Draft estimate: `production/fabric-cost-estimate.ts`.
  Form: `production-batch-form.tsx` (one "yard" input, `getFabricBalanceAction`).
- **Audit log:** `writeAuditLog` everywhere; catalog has `fabric`, `fabric_color`,
  `fabric_stock_movement`, `purchase`, `goods_receipt`, `production_batch`.

**Where colour is used today:** only product variants, product images, storefront/content
pickers, marketplace variant search and production-receipt line labels (`receipts/production.ts`
shows the SKU's colour name). **No inventory, purchase, receipt, defect or production-consumption
code reads or writes a colour.**

### 1.3 Data shape (local dev DB, read-only; prod not inspected per rules)

4 fabrics, 4 colours, **2 fabrics with no colours at all**; 1 fabric purchase line (an `ordered`
PO); 9 fabric ledger rows (5 legacy manual purchases, 3 voids, 1 production); 0 fabric defects; 2
posted batches, **both mixing colours**. Prod is the same shape, larger: every existing purchase
line and ledger row has no colour, some fabrics have no colours, and posted batches mix colours.

**Can the colourless rows stay valid?** Yes, by design. Every new column is **nullable**, and NULL
means "Tanpa warna". No CHECK requires a colour on old rows, no backfill guesses one, and the
ledger stays append-only (the immutability trigger already covers new columns). Balances that sum
over `fabric_id` alone (old release, overview, activity log) stay exactly right because the per-fabric
total doesn't change.

---

## 2. Decisions (proposed, confirm in §10)

- **D1. Colour is a stock dimension, not a new item.** Stock key = `(fabric_id, fabric_color_id)`
  with `fabric_color_id NULL` = "Tanpa warna". The fabric total = sum of all its colour buckets.
- **D2. Moving-average pool per colour bucket.** Same method (`valueDeltaForConsumption`,
  zero-residual rule, purchase moves the average, consumption/adjustment valued at the average,
  voids are exact negations), applied to the `(fabric, colour)` bucket instead of the whole
  fabric. The reason is that the price per yard can differ by colour, and a Sage-only batch
  should carry Sage's cost. HPP formula unchanged: `ceil((fabric + accessories + extra costs) / pcs)`,
  frozen at posting; posted HPP is never rewritten. **Confirmed (A1).**
- **D3. Lock stays per fabric row.** Every write that touches any colour of a fabric locks the
  `fabrics` row (as today). No new lock order and no deadlock surface. Balance checks are per bucket.
- **D4. Purchase line = (fabric, colour).** `purchase_items.fabric_color_id` nullable with a
  composite FK to `fabric_colors(id, fabric_id)`. One line per colour; a colour can appear once
  per PO. **New/edited lines must name a colour when the fabric has ≥1 active colour.** Tanpa warna
  is offered only for fabrics without active colours. A deactivated colour cannot be newly chosen
  but stays on lines that already have it (same rule as accessories/suppliers). Price stays
  `total_amount` per line (D6 of suppliers-goods-receipt), and the form adds a **Harga/yard** helper
  that fills the total.
- **D5. Receipts, defects, exchange and release inherit the colour from the purchase line.** No
  new receipt or defect columns. The sellable ledger row written by a receipt gets the line's
  `fabric_color_id`. Defect quantities per colour come from a join on `purchase_item_id`. The
  defect pool's **value** stays per fabric (D23 unchanged; defects never feed HPP).
- **D6. Production consumes per colour.** New table `production_batch_fabric_usages` (draft-editable,
  frozen at posting): one row per source bucket with yards. **Default:** one row per colour present
  in the batch lines (variant → `fabric_color_id`, always available), yards split by pcs. The owner
  can change a row's source to another colour or to Tanpa warna (needed while old stock is all
  Tanpa warna). `production_batches.fabric_yards` stays and is set to the sum of the rows
  (old release and readers keep working).
- **D7. Reclassification "Pindahkan ke warna" ships in S5.** It is a pair of `adjustment`
  movements (`reason='other'`, `ref_type='manual'`) in one transaction: out of the source bucket at
  its average (zero-residual rule), and into the target colour with the exact negated value. Fabric
  total qty and value are unchanged, and nothing is rewritten. **A3:** source is Tanpa warna or any
  colour, target is another colour of the same fabric; a free-text reason is required (stored as
  both rows' `note`); one audit entry.
- **D8. Accessories unaffected.** Accessories have size/size-group, not colour variants. No change.
- **D9. Permissions unchanged.** Same gates: `inventory.manage` (purchases, adjust, reclassify),
  `inventory.receive`, `production.manage`, `inventory.view`, `finance.view_profit` strips values.
- **D10. Audit.** Every write keeps its existing single audit entry, now including colour
  ids/names in `after`. Reclassify writes one `adjust` entry (`entityType: fabric_stock_movement`,
  `after: { out, in }`). Activity-log field labels gain `fabricColorId: "Warna"`.

---

## 3. Schema changes (expand-only, migration 0046 + 0047)

All additive. The previous release keeps working against the new schema: it never writes the new
columns (NULL = Tanpa warna), and it sums by `fabric_id`, which stays correct.

**0046_fabric_colour_stock.sql** (S1)

1. `purchase_items.fabric_color_id uuid NULL`
   - FK `(fabric_color_id, fabric_id)` → `fabric_colors(id, fabric_id)` ON DELETE RESTRICT ON
     UPDATE RESTRICT (MATCH SIMPLE: NULL colour skips the check).
   - CHECK `fabric_color_id IS NULL OR item_type = 'fabric'`.
   - Index `(fabric_color_id)` (RESTRICT FK rule).
   - New unique index `purchase_items_purchase_id_fabric_id_color_key ON (purchase_id, fabric_id,
     fabric_color_id) NULLS NOT DISTINCT WHERE fabric_id IS NOT NULL` (PG16, matches dev/prod).
     **Then drop** `purchase_items_purchase_id_fabric_id_key`. This is a loosening. The old release
     already dedups by fabric in `validateLines`, so it never relied on the index for correctness.
     Check that no error mapping matches the old index name; if one does, keep both indexes for one
     deploy and drop the old one in a later migration.
   - Re-create trigger `prevent_received_purchase_item_change` with `fabric_color_id` added to its
     `WHEN` list (function body unchanged).
2. `fabric_stock_movements.fabric_color_id uuid NULL`
   - FK `(fabric_color_id, fabric_id)` → `fabric_colors(id, fabric_id)` RESTRICT.
   - Index `(fabric_id, fabric_color_id, created_at)` (per-bucket balance + later-movement check),
     plus `(fabric_color_id)` if the composite doesn't lead with it (it doesn't; add it).
   - The immutability trigger already freezes it (jsonb compare). No change; a test proves it.
   - CHECK `purchase_void` rows copy colour: enforced in code. Optionally add a trigger-free test.
3. `production_batch_fabric_usages`
   - `id uuid pk`, `production_batch_id uuid not null`, `fabric_id uuid not null`,
     `fabric_color_id uuid null`, `yards numeric(10,2) not null check (yards > 0)`, `created_at`.
   - FK `(production_batch_id, fabric_id)` → `production_batches(id, fabric_id)` ON DELETE CASCADE
     ON UPDATE RESTRICT (existing `production_batches_id_fabric_id_key`).
   - FK `(fabric_color_id, fabric_id)` → `fabric_colors(id, fabric_id)` RESTRICT.
   - Unique `(production_batch_id, fabric_color_id) NULLS NOT DISTINCT`. Indexes on
     `production_batch_id` (covered by the unique) and `fabric_color_id`.
   - Trigger `prevent_posted_batch_fabric_usage_mutation`, a copy of
     `prevent_posted_batch_items_mutation` (0007): reject INSERT/UPDATE/DELETE when the parent batch
     is posted. The DELETE-by-cascade of a draft stays allowed.
4. No CHECK requiring a colour anywhere (old rows and old-release writes stay valid).
5. No reference data, no permission rows → nothing for `seed.ts`.

**0047** is reserved for S5 only if reclassify needs a marker (it shouldn't: see D7, it reuses
`type='adjustment'`, `reason='other'`, `ref_type='manual'` and an auto note). So likely no 0047.

Rollback safety: redeploying the previous image against 0046 works. The old release writes
colourless rows, which land in Tanpa warna. Old `postBatch` checks and values against the
**fabric total**, so after a rollback a per-colour bucket can be over-consumed (Tanpa warna can
go negative while the fabric total stays ≥ 0). The new release must tolerate a negative bucket on
read (show it, red-brick) and the owner fixes it with S5 reclassify. Documented in the deploy note.

Further rollback hazards (database review of S1), and how S1 closes the first one:
- **Void rows must copy the original's colour.** A release that writes coloured receipt rows (S3+)
  rolled back onto a release whose `reverseGoodsReceipt`/`voidFabricPurchase` builds the void row
  without `fabric_color_id` would leave the colour +qty and Tanpa warna −qty (fabric total still
  right). **S1 already copies `fabric_color_id` on both void paths** (tested), so any rollback
  target from S1 on is safe here. Only a rollback to a pre-S1 image keeps this hazard.
- **A pre-S2 `updatePurchase` drops line colours.** Its delete + reinsert of an unreceived PO's
  lines writes them colourless, so colours picked under S2+ are lost if that PO is edited after a
  rollback to S1 or earlier. Repair: re-pick the colours once rolled forward. Received lines are
  frozen by trigger, so they're unaffected.
- Skewed or negative buckets from any of the above are repaired with S5 "Pindahkan ke warna" or an
  adjustment, never by editing ledger rows.

---

## 4. Behaviour by area

### 4.1 Purchase form (`/purchases/new`, `/purchases/[id]/edit`)

- Line with Jenis = Kain shows **Warna** after Bahan (select with swatch + name + supplier code,
  active colours only, plus the line's current colour if since deactivated). Hidden, and the
  line is Tanpa warna, when the fabric has no active colours.
- **"Tambah semua warna"** button on a Kain line once its fabric is chosen: turns that line into
  one line per active colour not already on the PO (keeps the typed Harga/yard on each new line,
  Jumlah empty). Mobile-first layout: each colour row is Warna · Jumlah (yard) · Harga/yard ·
  Total harga.
- **Harga/yard** helper per fabric line: typing it fills `Total harga = round(qty × harga)`; Total
  stays editable (ongkir included, D6). Only `total_amount` is stored. The existing "≈ Rp X/yard"
  hint stays.
- Footer shows the total yards per fabric across colour lines and the PO total (838 yard /
  Rp 16.341.000 for the example).
- Server (`validateLines`, `assertItemsOrderable`): dedup key `fabric:fabricId:colorId|none`; the
  colour must belong to the fabric and be active unless already on this PO; a colour is required
  when the fabric has ≥1 active colour (read `fabric_colors` FOR SHARE in the same tx). Field
  errors in Indonesian ("Pilih warna untuk Marbella Anti UV.", "Warna Sage muncul dua kali.").
  `MAX_LINES` 50 stays (6 colours is fine).
- Detail page `/purchases/[id]`: line label "Marbella Anti UV, Sage" with swatch (UI text never uses an em dash); lines grouped
  by fabric with a per-fabric subtotal row.

### 4.2 Receiving, defects, exchange, release

- `receive-form.tsx`: one row per colour line (label with swatch), same Diterima / Ditolak inputs.
  Optional "Terima semua sisa" fills every row's outstanding.
- `postGoodsReceiptForPurchase`: select `purchase_items.fabric_color_id`, pass it into the
  `fabric_stock_movements` insert. Lock order unchanged (fabric ids sorted; colours share the
  fabric lock).
- `reverseGoodsReceipt`: `purchase_void` copies `fabric_color_id`. **Later-movement block narrows
  to the bucket** (`fabric_id` + `fabric_color_id IS NOT DISTINCT FROM`), so cutting Sage no longer
  blocks reversing a Mocca receipt. The negative-balance backstop also goes per bucket.
- Defects: reject/return/release code unchanged (per purchase line). Display adds colour:
  `getDefectDispositionsByPurchaseLine` callers show it via the line; `listDefectStockMaterials`
  and the fabric stock pages group fabric defects by `purchase_items.fabric_color_id` (join).
  `defect-actions.tsx` labels rows by colour. An exchange replacement arrives on the same line,
  so it gets the same colour automatically.

### 4.3 Fabric stock

- `lib/inventory/fabric-stock.ts`:
  - `getFabricColorBalance(fabricId, colorId | null)` → `{ qty, valueAmount }` for one bucket.
  - `listFabricColorBalances(fabricId)` → every bucket with a non-zero ledger history: colour id,
    name, hex, isActive, qty, value. Plus active colours with 0, plus Tanpa warna only when it has
    any movement.
  - `getFabricBalance` stays (fabric total) for existing callers.
  - `listFabricsWithBalance` adds a per-colour breakdown (one grouped query, no N+1).
  - `listFabricStockLedger` adds colour name/hex per row and an optional `colorId` filter
    (`?warna=<id>|tanpa`).
  - `recordFabricAdjustment` takes `fabricColorId` (required when the fabric has colour buckets;
    Tanpa warna allowed), checks and values **the bucket**.
  - Legacy `recordFabricPurchase`/`voidFabricPurchase`: unchanged, Tanpa warna (legacy path,
    no UI to create new ones; check `/purchases/legacy` is read/void only). Void blocks per bucket.
- `/fabrics/[id]` ("Warna" section): add **Stok** column per colour (yard, and ≈ Rp/yard with
  `finance.view_profit`), a Tanpa warna row when non-zero, and the **Total** row (existing headline
  number). Gated by `inventory.view` exactly as today.
- `/stock/fabrics` (Stok → Bahan): each fabric row shows total plus colour chips ("Sage 120 ·
  Mocca 80 · Tanpa warna 30"). Desktop table + mobile CardList both (CLAUDE.md e2e rule).
- `/stock/fabrics/[id]`: per-colour balance cards on top, a colour filter on the ledger, and a
  Warna column. "Sesuaikan stok" dialog gets a Warna select.
- Low-stock / overview: no fabric threshold exists today; nothing to change.

### 4.4 Production (`/production/new`, `/production/[id]`)

- Form replaces the single "Kain (yard)" input with a **Pemakaian kain per warna** block:
  - Rows auto-derived from the batch lines' colours (variant → colour) when lines change; each row:
    Warna sumber (select: the fabric's colours + Tanpa warna, each with its current stock),
    Yard. Default source = the matching colour.
  - A "Total yard" input + "Bagi sesuai pcs" helper splits the total across rows by pcs (2-dec
    rounding, remainder on the largest row). Owner can then edit each row.
  - Per row: stock hint and shortage warning ("Stok Sage 40 yard, kurang 12 yard"), with a quick
    "Ambil dari Tanpa warna" switch when Tanpa warna has stock.
  - Draft cost estimate = Σ rows × each bucket's current average (`estimateFabricCost` per bucket).
- Server `createDraft`/`updateDraft`: accept `fabricUsages[]`, validate (yards 2-dec > 0, colour
  belongs to the batch fabric, no duplicate source), replace the set, set `fabric_yards = Σ yards`.
  Inactive colour allowed as a source (it may still hold stock).
- `postBatch`: require ≥1 usage row with `Σ yards = fabric_yards`. A draft saved by the old
  release (no usage rows) is refused with "Isi pemakaian kain per warna lalu simpan.". Lock the
  fabric once, compute every bucket's balance, collect **all** shortages per bucket into the existing
  single message, write one `production` movement per usage row (ref = batch, colour set),
  `fabric_cost_amount = Σ consumption values`. The rest of HPP is unchanged.
- Batch detail/read-only: show the usage rows (colour, yard, and value with `finance.view_profit`).
  `getBatchCosts` already sums values. Check that it doesn't assume one fabric movement per batch
  (it reads `fabric_cost_amount`, which is fine).
- Posted batches from before this feature: no usage rows. The detail page shows "Kain: N yard
  (Tanpa warna, sebelum stok per warna)". Never rewritten.

---

## 5. Sessions

One session each, committed separately. TDD (`tdd-workflow`) for S1–S4 and S5 because they are
stock writes. UI is covered by e2e. Reviewers per CLAUDE.md: `database-reviewer` (S1, S2–S5
queries), `typescript-reviewer` + `react-reviewer` (all), `silent-failure-hunter` not needed (no
import/webhook).

### S1 — Schema (0046) + per-bucket balance primitives
- Drizzle schema + `drizzle-kit generate`, read the SQL, hand-append the trigger re-create, the
  new freeze trigger and the `NULLS NOT DISTINCT` index (drizzle may not emit it).
- `getFabricColorBalance`, `listFabricColorBalances`.
- **Tests (packages/db + admin):** migration test `migration-0046.test.ts` (existing colourless rows
  untouched; colour from another fabric rejected by FK; same colour twice on a PO rejected, two
  different colours of one fabric accepted, two colourless lines of one fabric still rejected;
  colour on an accessory line rejected; received line's colour frozen; ledger colour immutable;
  usage rows frozen once batch posted, deletable via draft cascade); balance tests (buckets sum to
  the fabric total, Tanpa warna bucket = colourless rows).

### S2 — Purchase lines per colour
- `lib/purchases/queries.ts`: input `fabricColorId`, validation, `lineValues`, `getPurchaseDocument`
  returns colour name/hex/isActive; edit page initial values.
- `purchase-form.tsx`: Warna select, "Tambah semua warna", Harga/yard helper, per-fabric subtotal.
  `/purchases/[id]` line labels + grouping.
- **Tests:** unit (required colour when fabric has colours; Tanpa warna allowed only without
  active colours; inactive colour refused on new, kept on edit; duplicate colour refused; foreign
  colour refused; audit `after.lines` has colour). E2E: create a PO with 3 colours via "Tambah
  semua warna", at 390px and 1280px; edit adds/removes a colour.

### S3 — Receipts, reversal, defects per colour
- `postGoodsReceiptForPurchase` writes colour; `reverseGoodsReceipt` copies colour, narrows the
  block to the bucket; receive form + defect labels; `listDefectStockMaterials` /
  `getDefectQtyByFabric` callers get a per-colour breakdown by join.
- **Tests:** receive 2 colour lines → two ledger rows with the right colour and value slices;
  over-receipt per colour line; reject on one colour → defect row on that line, sellable bucket
  untouched; reversal after consumption of **another** colour succeeds, after consumption of the
  **same** colour is refused; return-to-supplier re-opens and the replacement lands in the same
  colour; release unchanged.

### S4 — Fabric stock UI per colour + adjustment per colour
- `/fabrics/[id]` Stok column + Total; `/stock/fabrics` colour chips (table + cards);
  `/stock/fabrics/[id]` cards, filter, Warna column; adjust dialog with Warna.
- `recordFabricAdjustment` per bucket.
- **Tests:** adjustment values at the bucket average and refuses bucket < 0 even when the fabric
  total is fine; zero-residual rule per bucket. E2E: stock pages at both viewports.

### S5 — Production consumption per colour (+ optional reclassify)
- Usage table read/write in drafts, `postBatch` per bucket, form block, detail display.
- Reclassify (D7): `reclassifyFabricStock({ fabricId, fromColorId: null, toColorId, qty, note })`
  locks the fabric, checks the source bucket, writes the out/in adjustment pair, one audit entry.
  A "Pindahkan ke warna" button on `/stock/fabrics/[id]` (`inventory.manage`). Split into its own
  session (S6) if S5 runs long.
- **Tests:** default rows from line colours; split by pcs sums exactly; posting writes one movement
  per row with the per-bucket average, `fabric_cost_amount` = Σ, unit cost unchanged in formula;
  shortages listed per bucket in one message; Tanpa warna as a source; draft without usage rows
  refused at posting; reclassify keeps the fabric total qty and value identical and moves the value
  exactly.
- **E2E (the end-to-end journey asked for):** create PO with colours (Sage 10, Mocca 8) → receive
  all (Mocca with 1 yard rejected) → `/stock/fabrics/[id]` shows Sage 10, Mocca 7, total 17, defect
  Mocca 1 → production batch with Sage + Mocca SKUs, default usage rows → post → stock shows the
  remaining per colour, batch shows the per-colour fabric cost. Assert at 390px and 1280px.

### S6 (optional) — SPEC.md + docs
- SPEC.md fabric/stock sections, `docs/deploy.md` rollback note (bucket can go negative after a
  rollback; fix by reclassify/adjust). Can fold into S5.

---

## 6. Risks

- **Per-bucket stock right after launch:** all existing stock is Tanpa warna, so the first batches
  will mostly draw from Tanpa warna until colour purchases arrive or the owner reclassifies. The
  form's "Ambil dari Tanpa warna" and S5 reclassify cover it. A one-time stock count per colour is
  the cleanest start (adjust Tanpa warna down, adjust each colour up; or reclassify).
- **Average per colour vs per fabric (D2):** changes which average a batch gets. Batches posted
  before stay frozen.
- **Rollback window:** see §3.
- **`deleteFabricColor`:** new RESTRICT FKs make a colour used on a PO/ledger undeletable (falls
  to the existing generic FK message). Extend `getFabricColorUsageCounts` so the UI says why and
  offers deactivate.
- **Drizzle and `NULLS NOT DISTINCT`:** verify that the generated SQL matches. Hand-edit if needed and
  record it in the migration header.

---

## 7. Out of scope

Colour for accessories; per-colour minimum stock alerts; colour on legacy manual purchases;
backfilling colours onto old rows; a per-colour defect value pool; storefront changes.

---

## 8. Owner instructions for PO-202611-001 (JMS Textile, not yet received)

After S2 (purchase lines per colour) is deployed, and before receiving anything:

1. In **Bahan → Marbella Anti UV → Warna**, check that all 6 colours exist (name, supplier code,
   hex). Add any that are missing.
2. Open **Pembelian → PO-202611-001 → Ubah**. The current Marbella line has no colour. Pick the
   Marbella line, tap **"Tambah semua warna"**, type each colour's yards (they must add up to
   838 yard) and **Harga/yard Rp 19.500** (the totals fill in; add ongkir to a line if it was
   charged). Delete the old colourless line and save. The PO total should still be Rp 16.341.000
   (+ ongkir). Editing is allowed because nothing has been received yet. If a down payment was
   already recorded, the new total only has to be ≥ what's been paid.
3. When the fabric arrives, use **Terima barang** per colour line. Record defective yards per colour
   in "Ditolak (cacat)".
4. Don't receive it **before** S2/S3 are live. If it has to be received earlier, it lands as Tanpa
   warna and can be moved to colours later with "Pindahkan ke warna" (S5).

Existing stock (bought before this feature) shows as **Tanpa warna**. Either use it in production
by picking Tanpa warna as the source, or do one stock count and move it into colours (S5).

---

## 9. Verification per session

`pnpm --filter @ammari/db test`, `pnpm --filter @ammari/admin test`, `pnpm typecheck`, `pnpm lint`,
relevant e2e specs (`purchases-receipt.spec.ts`, `production-and-stock.spec.ts`, `defects.spec.ts`,
`defect-dispositions.spec.ts`, new `fabric-colour-stock.spec.ts`) against `ammari_e2e`, never the
owner's `ammari` DB.

---

## 10. Owner decisions (2026-11-21)

1. **A1 (D2): HPP uses each colour's own moving-average cost.** Pool = `(fabric, colour)` bucket,
   Tanpa warna is its own bucket. Method unchanged.
2. **A2 (D4): For a fabric with ≥1 active colour, every purchase line must name a colour.** No
   colourless line for such a fabric. Tanpa warna only for fabrics without active colours (and old
   rows).
3. **A3 (D7): "Pindahkan ke warna" allows Tanpa warna → colour AND colour → another colour of the
   same fabric.** Reason is required (free text, stored as the movements' note), audit-logged,
   total fabric quantity and value unchanged (out leg valued at the source bucket's average with
   the zero-residual rule, in leg = exact negation). Same fabric only; source ≠ target.
4. **A4 (D6): Production fabric usage defaults to a split by pieces per colour**; staff can edit
   the yards per colour (and the source bucket) before posting.
