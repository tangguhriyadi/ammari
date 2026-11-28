# TikTok Shop stock sync (Ammari → TikTok, one way)

Status: **S1 built** 28 Nov 2026 (data + read + preview, migration **0064**). **S2 built** 28 Nov 2026
(the push, migration **0065**, §7a). Nothing reaches TikTok's write API until S2 is deployed and the owner
turns the switch on (§9 runbook); the push also needs `seller.product.write` on the connection.

Goal: before launch (mid-December 2026), TikTok Shop's available quantity for every mapped SKU follows
Ammari's stock automatically. **Ammari is the source of truth**; TikTok is never read back into
Ammari's stock.

Sources read: `docs/plans/tiktok-shop-integration.md` (§3 data model, §4.4 stock timing, §7 secrets,
§9 cron and the T4-T9 build notes, §14 runbook, §15 checklist), `packages/commerce/src/stock/
{ledger,reservations}.ts`, `packages/db/src/stock-availability.ts`, `packages/commerce/src/tiktok/
{sync,apply,apply-rules,order-store,sku-mappings,connection}.ts`, `packages/tiktok-shop/src/{client,
orders,endpoints}.ts`. TikTok facts below are the ones the owner confirmed (28 Nov 2026); anything
beyond them is an **assumption to check in T0** (§8), never a silent guess.

---

## 0. Facts (owner, 28 Nov 2026)

- **Update Inventory:** `POST /product/202309/products/{product_id}/inventory/update`, scope Product
  Modify (`seller.product.write`, **granted on prod 28 Nov 2026**). Body
  `skus[{ id, inventory[{ warehouse_id, quantity }] }]`, `sku_warehouse_stock_update_mode:
  "INCREMENTAL"` (TikTok: FULL is not recommended for sync; never unlink warehouses). Quantity
  0..999,999. Product status must be `DRAFT`, `PENDING`, `FAILED`, `ACTIVATE` or `SELLER_DEACTIVATED`.
  **FBT warehouses must never be included.** At most 100 SKUs per product.
- **Errors to name:** 12052393 (locked for a promotion, cannot go below the current quantity), 12052141
  (managed at the global product), 12052921 (shares inventory with a source shop), 12052901 (status),
  12052556 / 12052036 (SKU), 12052097 / 12052530 / 12052531 (warehouse). **Per-SKU errors come back in
  `data.errors` with top-level `code` 0**: they are per-SKU failures, never a success.
- **Reading listings:** Search Products / Get Product (`seller.product.basic`, granted) give
  `product_id`, product status, SKU `id`, `seller_sku`, and per-warehouse inventory.

## 1. Owner decisions (28 Nov 2026)

1. **Quantity pushed = physical on-hand − stock held by unpaid website checkouts** (the existing
   `stock_reservations` hold, max 75 min; carts never hold stock). When a hold expires or is released,
   TikTok goes back up.
2. **No buffer.**
3. **Ammari overwrites TikTok.** From the moment sync is ON, the first sync and every change replace the
   TikTok quantity; manual edits in Seller Center are overwritten. TikTok SKUs whose `seller_sku`
   matches no Ammari variant are **never touched** and listed as unmapped.
4. **Its own switch "Sinkronkan stok ke TikTok"**, default OFF, separate from "Mulai terapkan pesanan".
   Before it is turned on, Integrasi > TikTok Shop shows a preview per SKU: "Stok TikTok sekarang →
   akan menjadi".

## 2. Safety rules (owner, 28 Nov 2026), and how each is enforced

| # | Rule | Enforced by |
|---|---|---|
| R1 | The stock switch can be ON only while "Mulai terapkan pesanan" is ON; turning orders OFF turns stock OFF (otherwise TikTok sales would not reduce Ammari stock and the push would raise TikTok back up). | **Database**, so no code path (including the previous release after a rollback) can break it: `CHECK (not stock_sync_enabled or orders_apply_enabled)` plus a `BEFORE UPDATE` trigger that sets `stock_sync_enabled = false` whenever `orders_apply_enabled` becomes false. `setTikTokStockSync` turns it on only with a conditional `UPDATE ... WHERE status = 'active' AND orders_apply_enabled RETURNING`; `setTikTokOrdersApply(false)` audits the stock switch going off with it. |
| R2 | Subtract, per variant, the pieces of TikTok orders that are **paid but not applied** in admin (held: `unknown_sku` mapped later, `short_stock`, duplicates, waiting for a backfill), so a held TikTok sale is never sold twice. | `computeTikTokTargetQuantity` (pure) takes them as an input; `tiktokHeldOrderQuantities` (pure) derives them from the stored snapshots and the SKU mapping. A held order whose line quantity cannot be read **holds the variant** (`tiktok_order_unclear`): an unknown quantity is never treated as 0. |
| R3 | Clamp to 0..999,999. | `computeTikTokTargetQuantity`; also a CHECK on the stored quantities. |
| R4 | Exactly one non-FBT warehouse per SKU; zero or several → held "gudang tidak jelas", never guessed. | Listing classification at read time (`classifyTikTokListingSku`). A warehouse counts as Ammari's only if Get Warehouse List names it a domestic sales warehouse (assumption A2, §8); every other warehouse id in a SKU's inventory is left alone. |
| R5 | Skip products in non-updatable statuses, and record why. | `hold_reason = status_not_updatable` with the raw status kept on the row. |
| R6 | Never push for an unmapped SKU; the `seller_sku` match is exact (the order mapping's rule) and reuses Pemetaan SKU TikTok. | The listing's variant comes **only** from `tiktok_sku_mappings` (active row). The listing read runs the same exact auto-map as the order store (trimmed, uppercase `seller_sku` = an active Ammari SKU; an inactive row, i.e. removed by a person, is never re-created). No mapping → `unmapped`. |

Added by this plan (proposed, for the owner to confirm; each one only ever **holds**, never guesses):

| # | Rule | Why |
|---|---|---|
| R7 | A variant mapped from **two or more TikTok listings** is held on all of them (`variant_on_several_listings`). | Q12 allows two TikTok SKUs to point at one variant. Pushing the full quantity to both would let TikTok sell it twice. The owner removes the extra listing (or its mapping) or tells us how to split. |
| R8 | A product with more than 100 SKUs is held (`product_too_many_skus`). | Update Inventory takes at most 100 per product; a partial push of a product is not attempted. |
| R9 | A SKU no longer listed by Search Products is held (`not_listed`) after a **complete** read pass. | Never push to a SKU TikTok did not just show us. An incomplete pass (budget, error) marks nothing. |
| R10 | A TikTok quantity that does not parse as a whole number 0..999,999 is held (`quantity_unreadable`). | Same rule as money (Q6): refuse, never round. |
| R11 | Nothing is pushed while the connection is not `active`, while either switch is off, or for a row whose last read is older than 2 h (S2). | A stale listing (wrong warehouse, status changed) must be re-read first. |

---

## 3. Data model (S1, migration 0064, expand-only)

`tiktok_shop_connections` gains three nullable/defaulted columns, like the T5 kill switch:
`stock_sync_enabled boolean not null default false`, `stock_sync_changed_at timestamptz`,
`stock_sync_changed_by_staff_user_id uuid` (FK staff_users, restrict, indexed), the CHECK and the
trigger of R1.

`tiktok_listing_skus`, one row per TikTok SKU of the connected shop:

| Column | Notes |
|---|---|
| `connection_id uuid` FK `tiktok_shop_connections` (restrict) | Part of the primary key. |
| `tiktok_sku_id text` | **PRIMARY KEY (connection_id, tiktok_sku_id)** (= the unique key). |
| `tiktok_product_id text not null` | Groups SKUs into one Update Inventory call (S2). |
| `product_status text not null` | Raw (`ACTIVATE`, `SELLER_DEACTIVATED`, ...), ≤ 64 chars. |
| `product_title text`, `sku_label text` | Display only (≤ 255). No buyer data exists on a product. |
| `seller_sku text` | As typed in TikTok. |
| `variant_sku text` FK `product_variants(sku)` **on delete set null** | The matched variant from the active mapping; NULL = unmapped. Set null so deleting a variant never needs this table; the next read recomputes. |
| `warehouse_id text` | Ammari's one warehouse for this SKU; NULL when unclear. |
| `tiktok_quantity integer` | Last read quantity at that warehouse (CHECK 0..999,999); NULL when unclear or unreadable. |
| `read_at timestamptz not null`, `first_seen_at` | `read_at` = the start of the read pass that last saw it. |
| `hold_reason text` | CHECK in `unmapped`, `status_not_updatable`, `warehouse_unclear`, `quantity_unreadable`, `variant_on_several_listings`, `product_too_many_skus`, `not_listed`. NULL = pushable as far as the listing goes. |
| `last_pushed_quantity integer`, `last_pushed_at timestamptz` | Written by S2 only. CHECK both or neither, quantity 0..999,999. |
| `last_push_error_code text`, `last_push_error_at` | S2. Codes only (≤ 64), never a body. |
| `created_at`, `updated_at` | `set_updated_at` trigger. |

Indexes: the primary key (connection lookups, the upsert target); `(variant_sku)` partial where not
null (S2: "which listings does this dirty variant feed", and the R7 count); `(connection_id,
tiktok_product_id)` (S2: one call per product). No index on `read_at` (one shop, a few hundred rows).

`tiktok_sync_cursors.resource` CHECK widened to include `products` (dropped and re-added as a superset
in the same file, the 0040 pattern): the read pass's `last_run_at` / `last_ok_at` / `last_error_code`.
The previous release never writes or reads that row.

Rollback: the previous release ignores the new table and columns. Its `setTikTokOrdersApply(false)`
still works: the trigger turns the stock flag off with it (R1 holds after a rollback too).

## 4. The read pass (S1)

Inside the existing `/api/internal/tiktok/sync` run (`runTikTokSync`), **after finance and before the
backfill**, so orders, packing and money never wait for listings:

- **Due** when the `products` cursor has no `last_ok_at` or it is ≥ 15 min old
  (`TIKTOK_LISTINGS_EVERY_MS`). Needs `seller.product.basic` and `seller.logistics` (the warehouse list);
  missing → `skipped: no_scope`, a cron warning, preview shows it. Runs whether the stock switch is on
  or off (the preview needs it).
- **Budget:** at most a quarter of the run's budget (`deadline` clamped, like the inbox gets half).
  Running out leaves the pass incomplete: rows already upserted stay, nothing is marked `not_listed`,
  `last_ok_at` does not move, so the next run (5 min) reads again.
- **Calls:** Get Warehouse List once (`GET /logistics/202309/warehouses`), then Search Products
  (`POST /product/202309/products/search`, `page_size` 100, every page; a repeated `page_token` or
  > 500 pages → `invalid_response`, like the order poll).
- **Per SKU** (pure `classifyTikTokListingSku`): status updatable? exactly one own warehouse? its
  quantity a whole number 0..999,999? Then the auto-map (the order store's rule, audited
  `tiktok_sku_auto_map`), then the active mapping decides `variant_sku`.
- **Upsert** `INSERT ... ON CONFLICT (connection_id, tiktok_sku_id) DO UPDATE` per product in one
  transaction; `last_pushed_*` are never touched by the read. Idempotent: a repeated read writes the same
  values (only `read_at` / `updated_at` move).
- **After a complete pass:** one UPDATE sets `not_listed` on rows of this connection with `read_at <
  pass start`; one UPDATE sets `variant_on_several_listings` on rows sharing a `variant_sku` (and clears
  it when they no longer do, falling back to the row's own reason).
- A product or SKU entry without a usable id → counted `invalid`, the pass is **incomplete**
  (`listings_invalid`, route 500 → ALERT after 3, like `incomplete` orders): never a silently short
  list that would mark real SKUs `not_listed`.

## 5. Target quantity (S1, pure, `computeTikTokTargetQuantity`)

```
target = clamp(physical − Σ active unexpired checkout holds − Σ held TikTok order pieces, 0, 999_999)
```

- `physical` = `SUM(stock_movements.qty)` for the variant (the ledger; the same figure as
  `physicalStockQtySql`).
- Holds count only `status = 'active' AND expires_at > now` (the `activeReservedQtySql` rule): an expired
  hold the sweep has not released yet already counts as back on the shelf, a released or consumed hold
  never counts (consumed pieces are in the ledger as a `sale`).
- Held TikTok pieces (R2): `tiktok_orders` with `order_id IS NULL`, `paid_time` set, status not `UNPAID`
  / `CANCELLED`, `apply_state` not `skipped_unpaid` / `skipped_undone`; their latest snapshot's lines,
  mapped through the active `tiktok_sku_mappings`, a missing `quantity` = 1 piece (T5's rule). A line
  whose quantity is unreadable → the variant is held `tiktok_order_unclear`. A line whose TikTok SKU is
  unmapped cannot be attributed: counted and shown as a warning on the page ("N pesanan TikTok ditahan
  punya SKU belum dipetakan"); once mapped it counts.
- Any non-integer input → `invalid_input` hold (a programming error made visible, never a number).
- The result is `{ kind: "push", quantity, breakdown }` or `{ kind: "hold", reason }`; listing holds
  (§3) come first, then variant holds.

## 6. Admin (S1)

Integrasi > TikTok Shop gains the sub-tab **Sinkron stok** (`/settings/integrations/tiktok/stock`,
`integrations.manage` on the server for the page and the action):

- Header: the switch state ("Aktif" / "Belum aktif"), **"Sinkronkan stok ke TikTok"** /
  "Hentikan sinkron stok" (confirmed, audited `tiktok_stock_sync_enable` / `_disable`). Disabled with
  the reason while "Mulai terapkan pesanan" is off ("Aktifkan Mulai terapkan pesanan dulu: tanpa itu
  penjualan TikTok tidak mengurangi stok Ammari") or while not connected. In S1 turning it on **only
  stores the flag** and the page says so ("Belum mengirim: pengiriman stok dibangun di tahap berikutnya").
- "Terakhir dibaca dari TikTok", the read's last error code, the scope warning, the unattributed
  held-order warning.
- Preview table (phone `CardList`, tablet/desktop `TableContainer`): Produk (TikTok title / Ammari
  product), Varian (Ammari colour · size), SKU (seller SKU, TikTok SKU id), Stok TikTok sekarang,
  Akan menjadi, Status / alasan ditahan. Counts on top: akan dikirim, sama, ditahan, belum dipetakan.
- "Izin yang diberikan" labels `seller.product.write` as **Modifikasi produk**.

## 6a. S1 build notes (28 Nov 2026)

- **Built as planned (§3-§6)**, migration **0064**, no TikTok write call anywhere (the fake TikTok in
  `stock-sync.test.ts` asserts the read pass only calls the warehouse list and Search Products).
- **R1 in the database:** CHECK + `BEFORE UPDATE OF orders_apply_enabled` trigger (only on ON → OFF, so
  turning stock on while orders are off still fails on the CHECK). `setTikTokOrdersApply(false)` writes
  a `tiktok_stock_sync_disable` audit (`after.reason = orders_apply_disabled`) when it took the stock
  switch with it.
- **Review fixes (code review, 28 Nov 2026), all fail-closed:** a product whose `skus` key is missing or
  not a list is invalid (pass incomplete), never "no SKUs"; the read compares the products seen with
  TikTok's `total_count` (`invalid_response:count_mismatch`), so a lost `next_page_token` never ends a
  pass "complete"; an inventory entry without a usable warehouse id makes the SKU `warehouse_unclear`;
  a held TikTok order with no readable lines (no list, empty, a non-object line) holds **every** mapped
  row (`tiktok_order_unclear`, banner on the tab); R7 is applied per product as it is stored and survives
  a re-read until a complete pass clears it; `read_at` never moves backwards (an older overlapping read
  writes nothing); an unknown stored hold reason is held (`invalid_input`); a pass stopped by its budget
  share records `budget_exhausted` on the `products` cursor (shown on the tab, cron "needs a look"); a
  complete pass with no own warehouse is a cron warning (A2); the preview reports `total` / `truncated`;
  the trigger keeps the previous changer when the orders writer named none.
- **Known limits, left as they are:** a pass restarts from page 1 each run (no resume token): a shop
  needing more than a quarter of the budget (≈ 37 s, thousands of SKUs) never completes and stays a
  visible `budget_exhausted`; fine at Ammari's size (tens of products). One mapping read and one upsert
  per SKU. The preview's counts cover the shown rows only (it says when it is truncated). A listing-only
  SKU cannot be mapped by hand yet (§7). `seller.product.write` is not required by S1.

## 7. S2 (plan only): the push

**Requirements from the S1 review (must hold in S2):**
- Re-resolve the variant from `tiktok_sku_mappings` and recompute R7 ("more than one pushable listing
  for this variant") **at push time**, from the tables, never from `tiktok_listing_skus.variant_sku` /
  `hold_reason` alone (a mapping can change between reads).
- Push only when the `products` cursor's last **complete** pass is newer than R11's 2 h and no pass is
  failing; push nothing for `not_listed`, `unmapped`, any hold, or while any held order is unreadable.
- Consider not auto-mapping from non-`ACTIVATE` listings (security review, low): a draft or test listing
  whose seller SKU matches becomes a mapping (audited, exact match only).

- **Dirty-variant outbox** `tiktok_stock_outbox(variant_sku pk, dirty_since, attempts, next_attempt_at,
  last_error_code)`, written **in the same transaction** as every change of physical stock or holds:
  `stock_movements` inserts (sales, receipts, production, opname/`saveStockCount`, adjustments,
  cancellations, returns, TikTok order apply), `reserveStockForOrder`, `consumeReservationsForOrder`,
  `releaseReservationsForOrder`, and the hold **expiry** (no write happens when a hold expires, so the
  cron enqueues variants whose holds expired since the last drain: `expires_at` in `(last_drain,
  now]`). Preferably one trigger each on `stock_movements` and `stock_reservations` (`INSERT ... ON
  CONFLICT (variant_sku) DO UPDATE SET dirty_since = least(...)`), so no write path can forget it; plus
  tiktok_orders apply-state changes (R2 inputs) and mapping changes.
- **Immediate best-effort push after commit** (`after()` in admin/web, never inside the stock
  transaction), plus the cron drain as the retry with backoff (1, 2, 4 … min, ≤ 1 h). Both under an
  advisory lock per product (`tiktok-stock:<product_id>`) so two pushers never interleave.
- **One API call per product:** all pushable SKUs of the product whose target ≠ `last_pushed_quantity`
  (skip when equal; the first push after ON compares against the read `tiktok_quantity` instead, so the
  first sync really overwrites, decision 3), only Ammari's warehouse, `INCREMENTAL`. Recompute the
  target **at push time** from the database, never from the outbox row.
- **Per-SKU results:** top-level `code` 0 with `data.errors` → each named SKU is a failure with its code
  (§0 list mapped to Indonesian reasons; 12052393 / 12052141 / 12052921 / 12052901 are "held until a
  person acts", not retried in a loop). Success writes `last_pushed_quantity/at`, clears the error.
- **Periodic full reconciliation:** the 15-min read compares `tiktok_quantity` with
  `last_pushed_quantity`; a difference (a Seller Center edit, a TikTok sale not yet applied) re-dirties
  the variant (decision 3: Ammari overwrites).
- **Health:** pushes OK / failed / held on the Sinkron stok tab, oldest dirty age, `ALERT` in the cron log
  after 3 failed drains in a row and a banner on Integrasi when a variant stayed dirty > 30 min.
- **Also in S2:** map a listing-only SKU on Pemetaan SKU TikTok (today a manual map needs the SKU on an
  order: `mapTikTokSku`'s `unknown_tiktok_sku`), the Update Inventory client in `packages/tiktok-shop`
  (the only write call), its error-code table, a fake for e2e, and the R11 staleness guard.

## 7a. S2 build notes (28 Nov 2026)

- **Outbox, insert-only (a deviation from the `variant_sku pk` sketch above, on purpose).**
  `tiktok_stock_outbox(id identity, variant_sku, source, created_at)` gets one row per change, written
  by `AFTER` triggers on `stock_movements` (insert), `stock_reservations` (insert, delete, a change of
  sku/qty/status/expires_at), `tiktok_sku_mappings` (old and new variant) and `tiktok_orders` (insert, a
  change of order_id/status/paid_time/apply_state/latest_snapshot_id: the variants its old and new
  snapshot lines map to; unreadable lines → every mapped variant). Triggers never `ON CONFLICT DO
  UPDATE`, so a stock write never waits on a row lock held by the push or another writer. Marks are
  written only while some connection has the stock switch on. The DB test asserts the triggers exist on
  all four tables, so a new writer of those tables is covered without code; each writer type is also
  tested (raw INSERT of every movement type, adjustStock, saveStockCount, reserve/consume/release, map,
  unmap, TikTok order insert/cancel, rollback → no mark).
- **Retry state** lives in `tiktok_stock_push_retries(variant_sku pk, attempts, next_attempt_at,
  last_error_code)`, written only by the push. Backoff 1, 2, 4 … min, ≤ 1 h; a mark newer than the last
  failure makes the variant due at once. Cursor resources `stock_push` (window_end = hold-expiry
  watermark; last_ok_at = last clean drain) and `stock_reconcile` (last full reconciliation and which
  switch-on it covered).
- **Drain** (`stock-push.ts`, shared by the cron and the after() push): gate (active connection, switch
  on and so orders apply on, `seller.product.write`, a complete listing pass < 2 h old and none failing
  since) → due variants → their products through the ACTIVE mapping → per product, under
  `pg_advisory_xact_lock('tiktok-stock:<connection>:<product>')`: re-read marks, rows, R7 from the tables,
  `loadTikTokTargetInputs` (the preview's loader), `planTikTokProductPush`, one Update Inventory call
  (own warehouse only, INCREMENTAL, ≤ 100), results written to the listing rows before the lock is
  released. A variant's marks (ids ≤ what was read) are deleted only once every product it feeds
  settled. Skip rule: target = last pushed and (TikTok's read agrees, or the read predates the push);
  first push compares with the read quantity. Two pushers of one product → one call (the second finds
  it unchanged); a change committed mid-push → the second pusher sends the fresh target (scratch-DB
  concurrency test).
- **Errors**: per-SKU `data.errors` (sku_id at the top or under `detail`; a named code in
  `extra_errors` wins; an error naming no SKU of the call fails every SKU) → 12052393 / 12052141 /
  12052921 held until **Kirim ulang yang ditolak** (audited `tiktok_stock_push_retry`); 12052901,
  12052556 / 12052036, 12052097 / 12052530 / 12052531 held until a newer read, and the read pass becomes
  due at once; anything else (rate limit, 5xx, network, an unknown code) retried with backoff.
- **When**: after() in admin (inside `revalidateStorefrontForSkus`, which every stock-changing action
  calls; mapping actions; switch on; Kirim ulang) and web (`revalidateProductPages`: payment
  notification, status check, sweep; checkout; the TikTok webhook's after()); single flight per process
  with one rerun, so a burst of checkouts uses one connection. The cron run (step 6c, after the read,
  ¼ budget) also queues hold expiries (`expires_at` in (watermark, now]), the hourly full
  reconciliation (and once after each switch-on), drift seen by a complete read (TikTok ≠ last pushed
  after the push), and purges marks while the switch is off.
- **Health** (Sinkron stok, while the switch is on): last push, variants waiting (warning after 30 min),
  automatic retries, SKUs TikTok refused with reason and code, why the gate is closed. The cron route
  answers 500 on a retryable push failure or a product error (three runs → ALERT, wording updated in
  both cron.sh); a refusal, a busy product, a closed gate with the switch on → "needs a look".
- **Review fixes (code review, 28 Nov 2026):** marks are settled by the exact ids read under the
  product lock, never "every id up to the highest" (identity ids are given at insert, not at commit, so a
  slower writer's lower id could commit mid-call and be deleted unpushed; regression test); the cron folds
  duplicate marks to one per variant (a long closed gate never grows the table); a closed gate is answered
  before credentials are loaded; a new change skips the backoff only after a non-rate-limit failure at
  least a minute old; a lock timeout (SQLSTATE read through Drizzle's `cause`) is `busy`, any other
  product failure backs off like a failed call; a database error in the cron's push step is counted
  (500) and never stops orders, finance or the backfill; the route keeps answering 500 while a variant
  has failed 3+ times in a row (so a long outage keeps the ALERT going) and warns on every run while
  refused SKUs wait; a complete read also re-queues never-pushed pushable listings and refusals it
  answers; numeric-string error codes are read as codes.
- **Not done in S2 (left for later):** mapping a listing-only SKU on Pemetaan SKU TikTok (`mapTikTokSku`
  still needs the SKU on an order); the banner on Integrasi for a variant dirty > 30 min (shown on the
  Sinkron stok tab only); not auto-mapping non-`ACTIVATE` listings. A4 (the `data.errors` shape) still
  to check in T0.

## 8. Assumptions to check in T0 (built on, never guessed silently)

- **A1** Search Products 202309: list key `products`, each with `id`, `status`, `title`, `skus[]` with
  `id`, `seller_sku`, `inventory[]` of `{ warehouse_id, quantity }`; an empty body lists every status. A
  renamed key → `invalid_response`, never an empty list.
- **A2** Get Warehouse List 202309: key `warehouses`, each `id`, `type`, `sub_type`. Ammari's warehouse is
  `type = SALES_WAREHOUSE` and `sub_type = DOMESTIC_WAREHOUSE`; FBT warehouses are not reported as such
  (they come from TikTok's FBT API). Anything else counts as not Ammari's, so an unknown shape holds
  SKUs as `warehouse_unclear` (loud), it never pushes to a guessed warehouse.
- **A3** `quantity` is a JSON integer. A string or fraction holds the SKU.
- **A4** (S2) the shape of `data.errors` in Update Inventory (`sku_id`, `code`, `message`).

## 9. Runbook (owner, after S2 is deployed)

1. Pemetaan SKU TikTok complete; Sinkron stok shows no `unmapped` row you expected to be mapped.
2. "Mulai terapkan pesanan" ON for at least a day (§14 step 8 of the integration plan).
3. Read the Sinkron stok preview: every "Akan menjadi" is what you expect. `Ditahan` rows understood.
4. **Sinkronkan stok ke TikTok**. Check in Seller Center that a few SKUs show the new quantity within
   5 minutes; Log Aktivitas has "Sinkron stok TikTok diaktifkan".
5. Undo: **Hentikan sinkron stok** (immediate). Turning orders off also stops it (R1). TikTok keeps the
   last pushed quantities; nothing is reverted.

## 10. Sessions

| # | Scope | Migration | Tests |
|---|---|---|---|
| **S1** (built) | 0064; Search Products + Get Warehouse List clients (read only); `classifyTikTokListingSku`, `tiktokHeldOrderQuantities`, `computeTikTokTargetQuantity` (pure); the read pass in `runTikTokSync` (15 min, ¼ budget); `setTikTokStockSync` + R1; Sinkron stok sub-tab with preview and switch (flag only); "Modifikasi produk" label. | **0064** | Unit: target (holds, expired/released/consumed holds, held TikTok orders, clamps, invalid input), held-order quantities (missing quantity = 1, unreadable → hold, unmapped → unattributed, skipped/applied/cancelled ignored), classification (statuses, warehouses 0/1/2/FBT-like, quantities), product/warehouse parsing. DB: read upsert idempotent, not_listed only after a complete pass, several listings, auto-map, switch invariant (CHECK, trigger, conditional enable, orders-off audits stock-off). e2e 390/1280: sub-tab preview from seeded listings, switch disabled while orders apply is off. |
| **S2** (built) | §7, §7a. | **0065** (outbox + triggers) | Unit: push planning (diff vs last pushed, first push vs read quantity, one call per product, ≤ 100), error mapping incl. per-SKU errors under code 0. DB: every stock write path enqueues in its own transaction (rollback → no outbox row), hold expiry enqueues, backoff, concurrency (two pushers → one call per product). Fake TikTok: no FBT warehouse ever in a body, INCREMENTAL always, unmapped SKUs never in a body. e2e: health on the tab at 390/1280. |
