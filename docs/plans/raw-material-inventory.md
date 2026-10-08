# Plan: Raw-Material Inventory (Accessories + Fabric Stock + BOM + Auto-Consumption)

Status: **approved**. Steps 1–4 (schema/migration 0008, ledger lib, `/accessories` UI,
product recipe section) executed in session A. Steps 5–7 (production-batch integration,
"Kebutuhan aksesoris" UI, full reviewer pass + e2e) are **pending**, to be executed in a fresh
session starting from this file.

## 1. Requirements restatement

1. **Accessories master** — new `/accessories` menu: list (stock + search), create, detail+ledger.
   Fields: name, optional size, optional size-group, active flag, notes. Stock always in pcs;
   moving-average cost per pcs stored without float drift.
2. **Purchases** (accessories + fabric) — date (Jakarta), item, quantity, total amount paid,
   optional supplier/notes; derived unit price shown read-only. Atomic stock+average update under
   a row lock. Backdatable. Voidable via a reversal movement (never a hard edit), blocked if it
   would drive stock negative.
3. **Fabric stock** — fabrics get the same stock/average mechanism, fed by purchases. The existing
   `fabrics.priceAmount/priceUnit` becomes reference-only. A batch's fabric cost is no longer
   hand-typed: computed at posting from yards × current average, snapshotted; draft shows a live
   estimate.
4. **Per-product accessory recipe (BOM)** on `/products/[id]`: rows of (one accessory OR a
   size-group) × qty/pcs. Size-group rows resolve per variant (sized → matching size item;
   all-size → the "Polos"/ALLSIZE item); an unresolved size blocks posting with a message naming
   product/size/group.
5. **Production batch integration**: draft shows computed accessory needs with shortage warnings
   and per-item overrides; posting locks batch + fabric + all affected accessories in a
   deterministic order, rejects (listing every shortage) if anything would go negative, writes
   consumption movements, snapshots costs, and folds accessory+fabric+service costs into HPP.
6. **cost_components → services only**: drop the 4 seeded goods from the seed; delete-or-deactivate
   them in the migration depending on whether local data references them (report which).
7. **Ledgers**: append-only movement tables for accessories and fabric
   (purchase/purchase_void/production/adjustment+reason/count), running balance on detail pages.
8. **Also in this migration**: extend the posted-batch trigger to reject changing `status` away
   from `'posted'`.
9. RBAC mapping; costs/averages never reach non-`finance.view_profit` sessions server-side.

## 2. Pattern grounding (what this mirrors)

| Concern | Existing precedent | How this reuses it |
|---|---|---|
| Append-only ledger, balance via SUM | `stock_movements` + `listStockLedger`'s windowed-SUM query | New `accessory_movements`/`fabric_stock_movements` tables, same shape |
| Lock-before-check-then-write | `lockVariantForUpdate` + `adjustStock`/`saveStockCount` in `lib/stock/queries.ts` | New `lockAccessoryForUpdate`/`lockFabricForUpdate`, same sequence |
| Deterministic multi-row lock order to avoid deadlock | `saveStockCount` sorts SKUs before locking | Posting sorts accessory ids (fabric locked first, always one row) |
| Snapshot-at-write-time to freeze history | `production_batch_costs.componentName/componentUnit` | Recipe resolution snapshots nothing extra — the movement row's qty+value already freezes the cost at posting |
| Hand-authored trigger extension | `prevent_posted_batch_field_change`'s WHEN clause | Same function, WHEN clause extended to also cover `status` |
| citext + unique, is_active not hard-delete | `fabric_colors`, `cost_components` | `accessories.isActive`, `accessories.sizeGroup` as citext |
| Discriminated-union form props, touched-field prefill | `production-batch-form.tsx` | Reused for the purchase form and recipe editor |
| `finance.view_profit` server-side stripping | Phase C's `createDraftAction`/`updateDraftAction` | Same discipline, applied correctly from the start |

## 3. Schema (migration `0008`, does not touch `0007`)

**`accessories`**: `id`, `name`, `size` (nullable, reuses the existing `Size`/`SIZES` enum —
`ALLSIZE` doubles as "Polos"), `size_group` (nullable **citext**), `is_active`, `notes`,
`timestamps()`. `unique(size_group, size)` (NULLs don't collide, so ungrouped rows are
unaffected).

**`accessory_movements`** (ledger): `id`, `accessory_id` → `accessories` (restrict), `qty`
(signed int), `value_amount` (signed bigint — see §4 for how this yields a moving average with no
mutable counter), `type` (`purchase`|`purchase_void`|`production`|`adjustment`), `ref_type`
(`production_batch`|`manual`), `ref_id`, `reason` (reuses `STOCK_ADJUSTMENT_REASONS`, adjustment
only), `supplier` (purchase only, optional), `purchased_at` (purchase only, required), `voids_movement_id`
(self-FK, purchase_void only), `voided_at`/`voided_by_staff_user_id` (set once on the original
purchase row), `created_by_staff_user_id`, `createdAtOnly()`. Pair-checks mirror the
`stock_movements`/`fabrics` idiom throughout. `unique(voids_movement_id)` — a purchase voids at
most once. Index `(accessory_id, created_at)` and `(ref_type, ref_id)`.

**`fabric_stock_movements`** — identical shape, `fabric_id` instead, `qty numeric(10,2)` (yards).

**`product_accessory_recipes`**: `id`, `product_id` → `products` (cascade), `accessory_id` null →
`accessories` (restrict), `size_group` null, `qty_per_pcs` (>0). `check (accessory_id is null) <>
(size_group is null)` (exactly one set). Partial uniques on `(product_id, accessory_id)` /
`(product_id, size_group)`.

**`production_batch_accessory_overrides`**: `id`, `production_batch_id` → `production_batches`
(cascade), `accessory_id` → `accessories` (restrict), `override_qty` (>=0),
`unique(production_batch_id, accessory_id)`. Keyed by the *resolved* accessory (a mixed-product
batch can have several recipe rows resolve to the same accessory).

**Trigger extension (requirement 8)**: widen `prevent_posted_batch_field_change`'s `WHEN` clause
to also fire when `OLD.status = 'posted' AND NEW.status IS DISTINCT FROM OLD.status` (same
function, reworded message, DROP+CREATE since a WHEN clause can't be ALTERed in place).

**Append-only triggers (correction #3, binding)**: `stock_movements`, `accessory_movements`, and
`fabric_stock_movements` all get a `BEFORE UPDATE OR DELETE` trigger.
- `stock_movements`: unconditionally rejects both (no exceptions — finished-goods movements are
  never corrected in place).
- `accessory_movements`/`fabric_stock_movements`: rejects DELETE always; rejects UPDATE unless the
  *only* columns changing are `voided_at`/`voided_by_staff_user_id`, going from NULL exactly once
  (`OLD.voided_at IS NOT NULL` → reject; compare `to_jsonb(NEW) - 'voided_at' - 'voided_by_staff_user_id'`
  against the same projection of `OLD`).

Test fixtures that directly `.delete(stockMovements)` for cleanup need a
trigger-disable/re-enable bypass (shared helper `withTriggerDisabled` in
`packages/db/test/helpers.ts`, mirroring Phase C's `forceDeletePostedBatchFixture`) — **never** a
reason to weaken the trigger itself.

**`cost_components` cleanup (requirement 6)**: in migration 0008, for each of the 4 seeded goods
("Kancing", "Handtag", "Plat metal brand", "Zipper packaging"): `DELETE` if no
`production_batch_costs` row references it, else `UPDATE ... SET is_active = false`. Idempotent,
expressed declaratively (no procedural block needed). "Ongkos jahit" (a service) stays untouched.
Seed script's `DEFAULT_COST_COMPONENTS` list shrinks to just that one entry.

**`PRD-202610-001`** needs no special handling — it predates this feature and simply has zero
rows in the new tables.

## 4. Key design decisions

- **Moving average without a mutable counter**: every movement row carries its own signed `qty`
  *and* `value_amount`. Current balance/value is always `SUM(qty)`/`SUM(value_amount)` over the
  ledger — not a cached counter — because each row's `value_amount` is computed once, under the
  item's row lock, from the SUM-so-far, before insertion (purchase: `value_amount =
  total_amount_paid` exactly; consumption/adjustment: valued at the current average, so only a
  purchase ever moves the average).
- **Correction #1 (zero-residual-value rule, binding)**: any movement that brings `SUM(qty)` to
  exactly 0 must set its own `value_amount` to exactly `-(current total value)`, not a
  separately-rounded `qty × average`, so the invariant `qty = 0 ⇒ value = 0` and `qty > 0 ⇒ value
  ≥ 0` holds exactly despite rounding. Not expressible as a per-row CHECK (it depends on the
  cumulative sum) — enforced in the application helper that computes a movement's value, and
  tested directly.
- **Correction #2 (void-after-later-movements, binding)**: a purchase can be voided **only if no
  consumption/adjustment/purchase_void movement exists for that item inserted after it** (checked
  by insertion order, under the item's row lock). Otherwise reject with an Indonesian message
  directing the user to "Sesuaikan stok" instead. Both the allowed and rejected paths get tests.
- **Backdated purchases don't reorder the average** — `purchased_at` is a display label only; the
  moving-average math always uses insertion order. Flag if different behavior is wanted later.
- **No separate `purchases` table** — a purchase is a ledger row with a few purchase-only nullable
  columns, consistent with how `stock_movements.reason` already works for `adjustment`.
- **Fabric and accessories stay two separate ledger tables** — `fabrics` is already deeply
  FK-entangled; a shared polymorphic items table isn't worth the join complexity for what's asked.
- **`fabric-cost.ts`/`.test.ts` (Phase C) become dead code** once the batch form's manual "Biaya
  bahan" input is replaced by a computed estimate — deleted in the deferred production-integration
  step, not this one (this session doesn't touch the batch form yet).
- **RBAC**: new group `inventory` — `inventory.view` (stock levels, ledgers) / `inventory.manage`
  (create/edit accessories, record purchases, void, adjustments), mirroring `stock.view`/
  `stock.adjust` exactly. Recipe editing on `/products/[id]` reuses `products.manage`. New
  permissions flow into `owner`'s defaults automatically via the existing exclusion-list
  mechanism.
- **Correction #4 (binding)**: `accessories.size_group` is **citext**, and the accessory form
  offers existing group names as a selectable/typeable list (native `<input list>` +
  `<datalist>` of distinct existing values — no new UI component needed) so case/typo variants
  don't fragment one logical group.
- **No bulk "count" screen for raw materials** — `recount` is just one `adjustment` reason,
  mirroring finished goods exactly; a single reason-based adjust form per item, not a sweep screen.
- **Purchase entry point**: a "Beli" button on `/accessories/[id]` and `/fabrics/[id]`, not a
  freestanding `/purchases` list page.
- **Nav placement**: "Aksesoris" under "Operasional" (next to Stok/Produksi).
- **Shortage rejection** (deferred step) returns a structured list of every short item, not
  fail-fast on the first.

## 5. Tests to plan

- Moving average across several purchases at different prices, incl. a rounding boundary.
- Zero-residual-value invariant after a full consume-to-zero sequence (correction #1).
- Void: success when nothing followed; rejected (Indonesian "Sesuaikan stok" message) when a later
  movement exists; double-void rejected; void-that-would-go-negative rejected (correction #2).
- Append-only triggers: UPDATE/DELETE rejected on `stock_movements`,
  `accessory_movements`/`fabric_stock_movements` except the one allowed voiding UPDATE; a second
  attempt to set `voided_at` again is rejected (correction #3).
- Size-group resolution: sized hit, ALLSIZE hit, missing size → error naming product/size/group
  — **deferred to the production-integration step**.
- Shortage rejection lists every shortage — **deferred**.
- Concurrent postings / deadlock-safety — **deferred**.
- Cost stripping for non-`finance.view_profit` sessions across list/detail/recipe.
- `PRD-202610-001` still renders with zero accessory rows, no crash — **deferred** (only matters
  once the batch detail page reads accessory consumption).

## 6. Risks

| Risk | Mitigation |
|---|---|
| `postBatch` becomes a large, multi-concern transaction | Deferred step; split into small helpers (resolve recipe → aggregate → shortage-check → lock+consume) composed in one transaction |
| Local `ammari` may already reference one of the 4 goods components | Checked at migration time; delete vs. deactivate decided per-component, reported |
| Scope is large for one session | Split explicitly: this session = schema + ledger lib + `/accessories` UI + recipe section; next session (fresh, from this file) = production integration + "Kebutuhan aksesoris" UI + full reviewer pass + e2e |

## 7. Implementation order

1. Schema + migration 0008 + permissions + seed cleanup. **(this session)**
2. Accessory/fabric ledger lib (moving average, lock helpers, purchase, void) + its tests. **(this session)**
3. `/accessories` UI (list/new/detail/ledger) + purchase form. **(this session)**
4. Recipe table + `/products/[id]` BOM section. **(this session)**
5. Production integration (resolution, shortage, locking, posting rewrite, HPP) + its tests. **(next session)**
6. UI for "Kebutuhan aksesoris" + extended cost breakdown. **(next session)**
7. Reviewer pass (react/typescript/security — database-reviewer already run after step 1–4) + full verification + e2e. **(next session)**

## 8. Session B design — production integration (steps 5–7)

Steps 1–4 are done and current (nav since restructured: purchases live at `/purchases`,
raw-material stock under `/stock` tabs, master pages read-only — see current code, not this
file's earlier nav notes). This section is the concrete design for steps 5–7, written down so it
survives a context reset.

### 8.1 New requirement folded in: fixed vs. variable cost components

Not in the original plan — added by the owner for this session:

- `cost_components.cost_type`: `text` CHECK IN `('variable', 'fixed')`, default `'variable'`.
  Seeded "Ongkos jahit" stays variable. Form label: "Variabel (per pcs)" / "Tetap (per batch)".
- `production_batch_costs.cost_type`: snapshotted alongside `component_name`/`component_unit`,
  same reasoning (a later rename of the component's cost_type must never rewrite history). NOT
  NULL, no default — always set explicitly at insert. Migration 0010 backfills existing rows from
  their joined `cost_components.cost_type` before adding the NOT NULL constraint.
- **Variable line**: form shows only "Harga per pcs" (`unit_price`). `quantity` is never
  submitted by the client — the server sets it to the batch's current total pcs
  (`sum(production_batch_items.qty)`) every time the batch is saved (create/update), and
  re-verifies/overwrites it again at posting (an `UPDATE ... SET quantity = totalPcs WHERE
  cost_type = 'variable'` immediately before computing totals) so a stale client-side value can
  never leak into HPP.
- **Fixed line**: form shows only "Nominal". Stored as `quantity = 1`, `unit_price = nominal`.
  Never recomputed from total pcs.
- HPP per pcs = `ceil((fabricCost + accessoryCost + sum(variable totals) + sum(fixed totals)) /
  totalPcs)` — same `calculateUnitCost` helper, just a different totalCost composition.
- Posted-batch breakdown groups (`BatchCostsSection` rewrite): **Kain**, **Aksesoris** (one line
  per resolved accessory, from its `accessory_movements` consumption row(s) for this batch),
  **Biaya variabel**, **Biaya tetap**, **Total**, **HPP/pcs**.

### 8.2 Fabric cost becomes computed, not hand-typed

- `production_batches.fabric_cost_amount` stays as a column (unchanged schema) but is no longer
  writable from the draft form — `createDraft`/`updateDraft` drop `costs: BatchCostsInput`
  entirely (no more manual fabric-cost input at draft time). It is set exactly once, at posting,
  to the fabric consumption movement's own (absolute) value.
- The draft form instead shows a **live estimate**: `fabricYards × current fabric average cost
  per yard` (via `getFabricBalance` + `averageCostPerUnit`), clearly labeled as an estimate, not
  editable. `lib/production/fabric-cost.ts`/`.test.ts` (the old `suggestFabricCost`, sourced from
  `fabrics.priceAmount/priceUnit`) are dead code per the original plan's own note — **deleted**,
  replaced by a new helper sourced from the ledger average instead (e.g.
  `estimateFabricCost(fabricYards, fabricBalance)`).
- At posting: lock the fabric row, read its balance, consumption value = `-valueDeltaForConsumption(balanceBeforeConsumption,
  -fabricYards)` (the zero-residual rule applies for free, since it's the same helper
  accessories/fabric adjustments already use) → this becomes `fabric_cost_amount`.

### 8.3 Accessory-needs resolution (`lib/production/accessory-needs.ts`, new file)

```ts
resolveAccessoryNeeds(lines: {sku, qty}[], db) ->
  { neededByAccessoryId: Map<accessoryId, qty>, unresolved: {productName, size, sizeGroup}[] }
```

- Join `lines` SKUs → `product_variants` (size, productId) → `products` (name, sizeMode) →
  `product_accessory_recipes` for each distinct productId.
- A recipe row with `accessoryId` set resolves directly (size-independent) — add
  `qtyPerPcs × line.qty` to that accessory's running total.
- A recipe row with `sizeGroup` set resolves **per variant**: the resolution key is the variant's
  own `size` column as-is (a sized variant's XS/S/M/L/XL; an all-size variant's `ALLSIZE`, which
  doubles as "Polos" — no separate mapping needed, `product_variants.size` already holds the right
  value either way). Look up `accessories` where `size_group` (citext, case-insensitive at the SQL
  level — compare in JS via `.toLowerCase()` once rows are pulled back) matches and `size` matches
  that key. Found → add to that accessory's total. Not found → push to `unresolved` (never
  throws itself — the caller decides: draft display shows it as a warning, posting rejects on any
  non-empty `unresolved` list, message naming every product/size/group in one message).

`getAccessoryNeedsForBatch(batchId, db)` (draft display) composes this with:
- the batch's current lines (read from `production_batch_items`, not client state — same
  "computed from what's actually saved" discipline as the cost estimate),
- existing overrides (`production_batch_accessory_overrides`),
- current stock per needed accessory (`getAccessoryBalance`),
- `effectiveQty = override ?? computed`, `shortage = effectiveQty > currentStock`.

### 8.4 Posting rewrite (`postBatch`)

Inside the existing transaction, after the batch-row lock and existing draft/lines/fabricYards
checks:

1. `resolveAccessoryNeeds(lines, tx)` — if `unresolved.length > 0`, reject immediately (a config
   problem, not a race; message lists every unresolved product/size/group).
2. Lock the fabric row (`lockFabricForUpdate`), then lock every needed accessory row in **sorted
   id order** (deterministic, avoids deadlock with a concurrent post/purchase/adjustment on the
   same items — mirrors `saveStockCount`'s own SKU-sort reasoning).
3. Compute every shortage (fabric: `fabricYards > balance.qty`; each accessory: `effectiveQty >
   balance.qty`, respecting an override) **without writing anything yet**; if any shortages
   exist, reject with ONE combined message listing every short item (fabric included).
4. Re-verify variable-line quantities: `UPDATE production_batch_costs SET quantity = totalPcs
   WHERE production_batch_id = id AND cost_type = 'variable'`.
5. Compute fabric cost (§8.2) and, for each resolved accessory, its consumption value via the
   same `valueDeltaForConsumption` helper — insert one `fabric_stock_movements` row
   (`type='production'`, `ref_type='production_batch'`, `ref_id=batchId`) and one
   `accessory_movements` row per resolved accessory (same ref shape).
6. `totalCost = fabricCost + Σ(accessory consumption values) + Σ(production_batch_costs.total)`
   (variable + fixed both included in that sum already). `unitCostAmount =
   calculateUnitCost(totalCost, totalPcs)` — unchanged helper.
7. Everything else (finished-goods `stock_movements` insert, `production_batch_items.unitCostAmount`
   update, `production_batches` status/postedAt/postedBy update, audit log) stays as today, just
   fed from the new `totalCost`.

### 8.5 "Kebutuhan aksesoris" UI

A server-computed section on the batch draft page (new `accessory-needs-section.tsx`, same shape
as `BatchCostsSection` — reads `getAccessoryNeedsForBatch`), listing each needed accessory with
current stock and a shortage badge. Per-row override uses a **single-row server action**
(`setAccessoryOverrideAction(batchId, accessoryId, overrideQty | null)`, `null` clears the
override row) rather than a batch-save form — smaller, lower-risk diff, consistent with this
codebase's existing single-row action idiom (void-purchase button, cost-component active toggle).

### 8.6 Implementation order (resumable)

1. `constants.ts` (`COST_COMPONENT_TYPES`) + `catalog.ts` schema edits (both `cost_type` columns,
   the two deferred leftmost indexes) → `drizzle-kit generate` → **read** migration 0010, hand-fix
   the `production_batch_costs.cost_type` backfill (generate as nullable, backfill from joined
   `cost_components`, then `ALTER ... SET NOT NULL`, same multi-step idiom other migrations use
   for a NOT NULL column added to a non-empty table).
2. `lib/production/accessory-needs.ts` + unit tests (sized hit, ALLSIZE hit, missing size, direct
   accessory row, mixed-product aggregation).
3. `lib/production/queries.ts`: drop `costs` from `CreateDraftInput`/`UpdateDraftInput`; rewrite
   `syncExtraCostLines` to snapshot `cost_type` and compute/re-verify variable quantity from
   totalPcs; rewrite `postBatch` per §8.4; delete `fabric-cost.ts`/`.test.ts`, add the new
   ledger-sourced estimate helper.
4. Cost-components lib/actions/UI: add `costType` field end to end (form select, list display).
5. Production batch form/actions: remove the fabric-cost input, wire the new estimate (read-only),
   split `extra-cost-lines.tsx` by `cost_type` (variable → "Harga per pcs" only; fixed →
   "Nominal" only, no quantity field either way).
6. "Kebutuhan aksesoris" section + override action; rewrite `BatchCostsSection`'s breakdown
   groups (§8.1).
7. Tests: unit (accessory-needs resolution, postBatch shortage incl. fabric, zero-residual on a
   full-consumption post, cost_type split HPP, re-verified variable quantity), extend
   `production-and-stock.spec.ts` e2e (purchase fabric + one accessory via `/purchases`, a recipe
   on a product, post a batch, assert stock decreased and HPP shown).
8. Verification (lean): related tests while working; at the end, one pass each of typecheck,
   lint, build, full unit/integration suite, e2e. Then `database-reviewer` + `security-reviewer`
   only — fix CRITICAL/HIGH. Report briefly; no commit.
