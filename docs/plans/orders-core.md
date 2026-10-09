# Plan: Orders Core + Manual Order Entry (`/orders`)

**Status:** Approved 2026-10-09. Implementation in progress.

Marketplace import (Shopee/TikTok) comes **later** as another input into this same system — this
plan designs the data model so the importer can be added without a further migration, but does
not build it.

## Grounding — what already exists

- **`channels`**: only `shopee`, `tiktok`, `web`, `reseller` exist today — no `whatsapp`/
  `instagram`/`offline`. Adding those for manual-entry channels.
- **`orders.status`** (`ORDER_STATUSES`): `awaiting_payment → to_ship → shipped → completed`,
  plus `cancelled`/`returned` — already defined, with matching `shippedAt`/`completedAt`/
  `cancelledAt`/`returnedAt` timestamp columns. Reused as-is; no new DB enum values.
- **`orders.totalAmount`** already has a DB `CHECK` enforcing
  `total = subtotal + shipping - discount` — server-side total computation is already
  structurally guaranteed.
- **`stock_movements.type`** already includes `sale`/`return` (not just `production`/
  `adjustment`), and **`ref_type`** already includes `order_item` — unused today, clearly
  reserved for this feature.
- **`stock_movements_type_ref_unique_idx`**'s own comment explicitly anticipates "a sale and a
  later return of the same order_item legitimately share the same ref_id with different types,
  and must both be allowed to post" — the exact idempotency/reversal mechanism this feature needs.
- **No cost tracking on `stock_movements`** — unlike `accessory_movements`/
  `fabric_stock_movements`, there's no `value_amount` column, so there's no way today to derive a
  moving-average HPP for finished goods. `order_items.unitCost` exists and is documented as
  "locked at the moment the order is recorded," but nothing computes it yet.
- **`lib/inventory/moving-average.ts`** (`averageCostPerUnit`, `valueDeltaForConsumption`)
  operates on a generic `{ qty, valueAmount }` shape — reused unchanged for finished goods.
- **Locking precedent**: `stock/queries.ts`'s `saveStockCount` sorts SKUs before locking
  (`sortedLines`) to avoid cross-transaction deadlocks — the identical pattern is used here for
  order creation/cancellation touching multiple SKUs.
- **`customers.email`** is `NOT NULL UNIQUE`, **`customers.pdpConsentAt`** is `NOT NULL` — both
  assume a self-service signup with consent. Manual order entry's ask ("name, optional phone" —
  no email, no consent flow) conflicts with this; both become nullable (approved).
- **`orders.buyerUsername`** (free text) + nullable `orders.customerId` already shows the schema
  tolerates an order with no resolved `customers` row.
- **UI patterns mirrored**: `purchases/page.tsx` (list: `FilterTabs` + `Pagination` +
  `Breadcrumb`) and `purchases/_components/purchase-list.tsx` (dual `CardList` (mobile) +
  `TableContainer` (desktop) — required by SPEC §2.5's mobile-first rule for Orders).
  `purchases/new` + `actions.ts` is the form/server-action pattern mirrored for `/orders/new`.
  `generateBatchNumber` (`production/batch-number.ts`, advisory-lock + `split_part`) is the
  precedent for the new order-number generator.
- Permissions today: `orders.view`, `orders.import`, `finance.view_profit` exist. New:
  `orders.manage` (create/edit a manual order, transition its status).
- `/orders` and `/customers` are both currently `ComingSoonPage` stubs.

## Schema changes — migration `0011`

**`constants.ts`**
- `CHANNEL_IDS`: add `"whatsapp"`, `"instagram"`, `"offline"`.
- New `ORDER_STATUS_TRANSITIONS` (app-level constant in `apps/admin/src/lib/orders/status.ts`,
  NOT in `packages/db` — `packages/db` stays schema-only per SPEC §10):
  ```
  awaiting_payment → [to_ship, cancelled]
  to_ship          → [shipped, cancelled]
  shipped          → [completed, returned]
  completed        → [returned]
  cancelled        → []   (terminal)
  returned         → []   (terminal)
  ```
  `shipped → cancelled` is deliberately **not** allowed — refused/failed deliveries go through
  `returned` instead. Enforced in one server function, `transitionOrderStatus`, that every caller
  (manual UI action, future importer, future packing page) must go through.

**`orders` table**
- `channelOrderNo`: drop `.notNull()` → nullable. Postgres composite `UNIQUE` already treats
  multiple `NULL`s as distinct, so no partial index needed.
  - **Required, validated server-side, for marketplace channels** (`shopee`, `tiktok`) — so a
    later import of the same order hits the existing unique key and updates instead of
    duplicating. **Optional** for `whatsapp`/`instagram`/`offline`/`web`/`reseller`.
- Add `orderNo text NOT NULL UNIQUE` — internal, always-present, human-readable number, format
  **`ORD-YYYYMM-NNNN`** (Jakarta month, 4-digit sequence), generated via `generateOrderNumber(tx)`
  mirroring `generateBatchNumber` (per-month `pg_advisory_xact_lock` + `max(split_part(...))`).
- Add `createdByStaffUserId uuid` nullable, FK → `staff_users` (restrict).
- Add `shippingAddress text` nullable — free text; a structured `customer_addresses` table stays
  deferred to the Dec 2026 checkout work (SPEC §5.2).
- Add `notes text` nullable.

**`customers` table**
- `email`: drop `.notNull()` → nullable.
- `pdpConsentAt`: drop `.notNull()` → nullable — a staff-created customer has given no PDP
  consent; stamping it automatically would misrepresent consent never actually given. Stays
  `null` until the buyer later self-serves (voucher claim or main-site signup).

**`stock_movements` table**
- Add `valueAmount bigint`, mirroring `accessory_movements.valueAmount`/
  `fabric_stock_movements.valueAmount` — enables the same moving-average math for finished goods.
  - **Backfill** (hand-authored SQL in the same migration): existing `type='production'` rows get
    `value_amount = qty * production_batch_items.unit_cost_amount` (joined via `ref_id`); existing
    `type='adjustment'` rows backfill to `0`.
  - The backfill `UPDATE` runs with `prevent_stock_movement_mutation` **disabled**, then
    re-enabled immediately after, in the same migration (identical idiom to migration 0010's
    `prevent_posted_batch_cost_mutation` disable-then-reenable around its own backfill).
  - `NOT NULL` once backfilled.
  - `postBatch` (production) updated to also write `valueAmount = qty * unitCostAmount` on every
    future `stockMovements` insert.
  - **Bug fix**: `adjustStock` and `saveStockCount` (manual stock adjustment / stock count) are
    updated to value their movements too, using the identical rules raw materials already use
    (`lib/inventory/moving-average.ts`, reused unchanged): only a production-equivalent inflow
    moves the average; a movement that brings qty to exactly 0 clears the remaining value exactly;
    invariant `qty = 0 ⇒ value = 0`, `qty > 0 ⇒ value ≥ 0`.

No changes needed to `order_items`, `STOCK_MOVEMENT_TYPES`, or `STOCK_MOVEMENT_REF_TYPES` — all
already shaped for this.

## Status flow

Reuse `ORDER_STATUSES` as-is. Manual entry defaults new orders to `to_ship` (payment already
settled off-platform), with `awaiting_payment` available for orders where payment is still
pending. `transitionOrderStatus` is the only path that moves an order between statuses, checks
`ORDER_STATUS_TRANSITIONS`, sets the matching timestamp column, and triggers the stock-movement
side effect below where applicable — all in one transaction.

## Finished-goods stock: when it decreases

**On creation**, for any order inserted directly into `to_ship`/`shipped`/`completed`, and on the
`awaiting_payment → to_ship` transition for orders that start unpaid.

Per order item, under a transaction:
1. Sort the order's SKUs ascending and `lockVariantForUpdate` each in that order (same precedent
   as `saveStockCount`).
2. Read each SKU's current `{qty, valueAmount}` balance.
3. Reject if `qty - orderedQty < 0` for any line — surfaced as a field error on the specific SKU.
4. Insert one `stock_movements` row per line: `qty = -orderedQty`, `type = 'sale'`,
   `refType = 'order_item'`, `refId = orderItem.id`,
   `valueAmount = valueDeltaForConsumption(balance, -orderedQty)`.
5. Snapshot `orderItems.unitCost = round(-valueAmount / orderedQty)` — locked forever after.

**Order items are editable only while `status = awaiting_payment`.** Once stock has left
(`to_ship` and later), items/qty/prices are locked server-side — the fix for a mistake is
cancel + recreate, never an in-place edit of a line that already has a stock/cost consequence.

**Cancel/return are whole-item** (full qty per order item), matching the `(type, ref_type,
ref_id)` unique key — no partial-quantity returns in v1. A returned item goes back to stock **at
its original cost**: insert an exact-reversal `stock_movements` row — `type = 'return'`, same
`refId`, `qty = +orderedQty`, `valueAmount = -(the original sale row's valueAmount)` — never
re-derived from the *current* average (same idiom as `accessory_movements`' `purchase_void`). If
the returned item is actually damaged, staff then separately runs "Sesuaikan stok → rusak" — the
return itself never assumes damage.

This needs zero new stock-movement types or ref-types beyond the new `valueAmount` column.

## HPP / costing method

**Moving average per SKU**, not FIFO — consistent with the existing raw-material convention,
reusing `lib/inventory/moving-average.ts` verbatim. Cost data (`unitCost` on `order_items`, any
HPP/profit figure on the order detail page) is computed server-side and stripped before reaching
the client for any session without `finance.view_profit`.

## Idempotency for the future importer

- `orders_channel_id_channel_order_no_key` — unique `(channel_id, channel_order_no)`, required
  for `shopee`/`tiktok` even on manual entry — a re-import upserts onto this key instead of
  inserting a duplicate order.
- `order_items_order_id_sku_key` — prevents duplicate line items on retry.
- `stock_movements_type_ref_unique_idx` on `(type, ref_type, ref_id)` — prevents a retried import
  from double-posting the same `sale`/`return` movement for the same `order_item`.

A re-import's status change must go through the same `transitionOrderStatus` function — never a
raw `UPDATE`.

## RBAC

New permission: **`orders.manage`** (group `orders`) — create/edit a manual order, transition its
status. `owner` and `super_admin` get it by default. `orders.import` stays separate.

## Pages & files

- `apps/admin/src/app/(shell)/orders/page.tsx` — list, replacing the stub. `FilterTabs` by status,
  search by order no/customer, `Pagination`.
- `.../orders/_components/order-list.tsx` — `CardList` + `TableContainer`.
- `.../orders/[id]/page.tsx` — detail: totals, line items (cost gated by `finance.view_profit`),
  status timeline (derived from the existing timestamp columns), status-transition buttons.
- `.../orders/new/page.tsx` + `_components/order-form.tsx` — manual entry form.
- `.../orders/actions.ts` — `createOrderAction`, `transitionOrderStatusAction`.
- `apps/admin/src/lib/orders/{queries,status,order-number}.ts`.
- `apps/admin/src/lib/customers/queries.ts` — search/create (name + optional phone only; address
  lives on the order, not the customer).
- `packages/db/src/rbac/permissions.ts` — add `orders.manage`.
- Schema files + migration `0011` as above.

## Explicitly NOT building now

Packing UI + QR thank-you cards, the Shopee/TikTok importer itself, accounting journals.

## Resolved open questions

1. New manual channels `whatsapp`/`instagram`/`offline` — **yes**.
2. `customers.email`/`pdpConsentAt` nullable — **yes**.
3. Order number format — **`ORD-YYYYMM-NNNN`** (Jakarta month, advisory-lock + `split_part`
   pattern from batch numbers).
4. Stock-decrement point — **on creation / on `awaiting_payment → to_ship`**.
5. `shippingAddress` free text on `orders` — **yes**.
6. `shipped → cancelled` — **no**; refused/failed deliveries go through `returned`.
