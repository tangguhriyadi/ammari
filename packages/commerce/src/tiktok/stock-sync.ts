import "server-only";
import { sql } from "drizzle-orm";
import { TIKTOK_LISTING_HOLD_REASONS, type Size, type TikTokListingHoldReason } from "@ammari/db/schema";
import type { AllowlistedObject, TikTokListingProductRecord } from "@ammari/tiktok-shop";
import { writeAuditLog, type Database } from "../db";
import { autoMapTikTokSkuLines } from "./order-store";
import {
  classifyTikTokListingSku,
  computeTikTokTargetQuantity,
  tiktokHeldOrderQuantities,
  type TikTokCheckoutHold,
  type TikTokHeldOrderQuantities,
  type TikTokOwnWarehouses,
  type TikTokTargetHoldReason,
  type TikTokTargetResult,
} from "./stock-sync-rules";

// TikTok stock sync, S1 (docs/plans/tiktok-stock-sync.md §3-§6): the listing store the read pass
// writes, the preview the Sinkron stok tab shows, and the switch. NOTHING HERE CALLS TIKTOK: the push
// (S2) is stock-push.ts. Turning the switch on queues every mapped variant (the first full push).

/** Update Inventory takes at most this many SKUs per product (owner facts, 28 Nov 2026; R8). */
export const TIKTOK_MAX_SKUS_PER_PRODUCT = 100;

// ---- Listing store (the read pass) ------------------------------------------------------------

export interface StoreTikTokListingProductResult {
  skus: number;
  autoMapped: string[];
}

/** A stored hold reason this code does not know (a newer release's, after a rollback) fails CLOSED:
 * the row is held, never shown or pushed as if nothing were wrong. */
function holdOf(reason: string | null): TikTokListingHoldReason | "invalid_input" | null {
  if (reason === null) return null;
  return (TIKTOK_LISTING_HOLD_REASONS as readonly string[]).includes(reason) ? (reason as TikTokListingHoldReason) : "invalid_input";
}

/** One product of a read pass, in one transaction: classify each SKU (R4, R5, R8, R10), run the exact
 * auto-map (R6, the order store's rule), then take the variant from the active mapping only and upsert
 * on (connection, TikTok SKU). Idempotent: the same product read again writes the same values (only
 * `read_at` moves). Never touches what S2 pushed (`last_pushed_*`, `last_push_error_*`). */
export async function storeTikTokListingProduct(
  db: Database,
  input: { connectionId: string; product: TikTokListingProductRecord; ownWarehouses: TikTokOwnWarehouses; readAt: Date },
): Promise<StoreTikTokListingProductResult> {
  const { product } = input;
  const tooMany = product.skuCount > TIKTOK_MAX_SKUS_PER_PRODUCT;
  return db.transaction(async (tx) => {
    const autoMapped = await autoMapTikTokSkuLines(
      tx,
      product.skus.map((sku) => ({ skuId: sku.skuId, productId: product.productId, sellerSku: sku.sellerSku })),
    );
    for (const sku of product.skus) {
      const classified = classifyTikTokListingSku({ productStatus: product.status, inventory: sku.inventory, ownWarehouses: input.ownWarehouses });
      const [mapping] = await tx.execute<{ variant_sku: string }>(sql`select variant_sku from tiktok_sku_mappings where tiktok_sku_id = ${sku.skuId} and is_active`);
      const variantSku = mapping?.variant_sku ?? null;
      // Unmapped first: such a SKU is never touched whatever else is true (decision 3).
      const holdReason: TikTokListingHoldReason | null = !variantSku ? "unmapped" : classified.holdReason === "status_not_updatable" ? "status_not_updatable" : tooMany ? "product_too_many_skus" : classified.holdReason;
      await tx.execute(sql`
        insert into tiktok_listing_skus as l (connection_id, tiktok_sku_id, tiktok_product_id, product_status, product_title, sku_label, seller_sku, variant_sku, warehouse_id, tiktok_quantity, read_at, hold_reason)
        values (${input.connectionId}::uuid, ${sku.skuId}, ${product.productId}, ${product.status}, ${product.title}, ${sku.label}, ${sku.sellerSku}, ${variantSku}, ${classified.warehouseId}, ${classified.quantity}, ${input.readAt.toISOString()}::timestamptz, ${holdReason})
        on conflict (connection_id, tiktok_sku_id) do update set
          tiktok_product_id = excluded.tiktok_product_id,
          product_status = excluded.product_status,
          product_title = excluded.product_title,
          sku_label = excluded.sku_label,
          seller_sku = excluded.seller_sku,
          variant_sku = excluded.variant_sku,
          warehouse_id = excluded.warehouse_id,
          tiktok_quantity = excluded.tiktok_quantity,
          read_at = excluded.read_at,
          -- R7 survives a re-read: only a complete pass (finishTikTokListingPass) clears it, so a pass
          -- that stops early never reopens a variant sold on two listings.
          hold_reason = case
            when excluded.hold_reason is null and l.hold_reason = 'variant_on_several_listings' and l.variant_sku is not distinct from excluded.variant_sku then l.hold_reason
            else excluded.hold_reason
          end
        -- Two overlapping reads never move read_at backwards (a late older pass would make a newer
        -- pass's finish mark a live SKU not_listed).
        where l.read_at <= excluded.read_at
      `);
    }
    // R7 at once, not only at the end of the pass: a variant this product shares with another listing
    // of the connection that is not held for its own reason is held on every such listing now.
    const variants = [...new Set((await tx.execute<{ variant_sku: string }>(sql`
      select variant_sku from tiktok_listing_skus where connection_id = ${input.connectionId}::uuid and tiktok_product_id = ${product.productId} and variant_sku is not null
    `)).map((row) => row.variant_sku))];
    if (variants.length > 0) {
      await tx.execute(sql`
        update tiktok_listing_skus l set hold_reason = 'variant_on_several_listings'
        where l.connection_id = ${input.connectionId}::uuid and l.hold_reason is null
          and l.variant_sku in (
            select variant_sku from tiktok_listing_skus
            where connection_id = ${input.connectionId}::uuid and variant_sku in (${sql.join(variants.map((sku) => sql`${sku}`), sql`, `)})
              and (hold_reason is null or hold_reason = 'variant_on_several_listings')
            group by variant_sku having count(*) > 1
          )
      `);
    }
    return { skus: product.skus.length, autoMapped };
  });
}

/** After a COMPLETE read pass only (never after one that stopped early, R9): SKUs of the connection
 * the pass did not see are `not_listed`; listings sharing a variant with another pushable listing are
 * held on all of them (R7). Returns the counts. */
export async function finishTikTokListingPass(db: Database, input: { connectionId: string; passStart: Date }): Promise<{ notListed: number; severalListings: number }> {
  return db.transaction(async (tx) => {
    const at = input.passStart.toISOString();
    const notListed = await tx.execute(sql`
      update tiktok_listing_skus set hold_reason = 'not_listed'
      where connection_id = ${input.connectionId}::uuid and read_at < ${at}::timestamptz and hold_reason is distinct from 'not_listed'
      returning tiktok_sku_id
    `);
    // Exactly, over what this complete pass saw: listings pushable apart from R7, grouped by variant.
    const shared = sql`
      select variant_sku from tiktok_listing_skus
      where connection_id = ${input.connectionId}::uuid and read_at = ${at}::timestamptz and variant_sku is not null
        and (hold_reason is null or hold_reason = 'variant_on_several_listings')
      group by variant_sku having count(*) > 1
    `;
    await tx.execute(sql`
      update tiktok_listing_skus set hold_reason = null
      where connection_id = ${input.connectionId}::uuid and hold_reason = 'variant_on_several_listings' and variant_sku not in (${shared})
    `);
    await tx.execute(sql`
      update tiktok_listing_skus l set hold_reason = 'variant_on_several_listings'
      where l.connection_id = ${input.connectionId}::uuid and l.read_at = ${at}::timestamptz and l.hold_reason is null and l.variant_sku in (${shared})
    `);
    // How many listings the hold covers after this pass (some were held already while storing).
    const [several] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from tiktok_listing_skus where connection_id = ${input.connectionId}::uuid and hold_reason = 'variant_on_several_listings'`);
    return { notListed: notListed.length, severalListings: Number(several?.n ?? 0) };
  });
}

// ---- The switch (R1) --------------------------------------------------------------------------

export type SetTikTokStockSyncResult = { ok: true; changed: boolean } | { ok: false; reason: "not_connected" | "orders_apply_off" };

/** "Sinkronkan stok ke TikTok" / "Hentikan sinkron stok" (integrations.manage, audited). ON needs an
 * active connection with "Mulai terapkan pesanan" ON, checked in the same conditional UPDATE (and by
 * the database CHECK, R1). OFF works on the current connection whatever its state. ON queues every
 * mapped listing's variant in the same transaction (the first full push, S2: the preview the owner saw);
 * the caller then starts the push after the commit. */
export async function setTikTokStockSync(db: Database, input: { enabled: boolean; staffUserId: string; now?: Date }): Promise<SetTikTokStockSyncResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{ id: string; status: string; orders_apply_enabled: boolean; stock_sync_enabled: boolean }>(sql`
      select id, status, orders_apply_enabled, stock_sync_enabled from tiktok_shop_connections
      where ${input.enabled ? sql`status = 'active'` : sql`status = 'active' or stock_sync_enabled`}
      order by case when status = 'active' then 0 else 1 end, updated_at desc
      limit 1 for update
    `);
    if (!row) return { ok: false, reason: "not_connected" };
    if (row.stock_sync_enabled === input.enabled) return { ok: true, changed: false };
    if (input.enabled && !row.orders_apply_enabled) return { ok: false, reason: "orders_apply_off" };
    const at = (input.now ?? new Date()).toISOString();
    const updated = await tx.execute<{ id: string }>(sql`
      update tiktok_shop_connections set stock_sync_enabled = ${input.enabled}, stock_sync_changed_at = ${at}::timestamptz,
        stock_sync_changed_by_staff_user_id = ${input.staffUserId}::uuid, updated_at = now()
      where id = ${row.id}::uuid and stock_sync_enabled = ${!input.enabled}
        ${input.enabled ? sql`and status = 'active' and orders_apply_enabled` : sql``}
      returning id
    `);
    if (updated.length === 0) return { ok: false, reason: input.enabled ? "orders_apply_off" : "not_connected" };
    await writeAuditLog(tx, {
      actorStaffUserId: input.staffUserId,
      action: input.enabled ? "tiktok_stock_sync_enable" : "tiktok_stock_sync_disable",
      entityType: "tiktok_shop_connection",
      entityId: row.id,
      before: { stockSyncEnabled: !input.enabled },
      after: { stockSyncEnabled: input.enabled },
    });
    if (input.enabled) await queueAllMappedTikTokStock(tx, row.id, "enable");
    return { ok: true, changed: true };
  });
}

/** Marks every variant an active mapping of one of the connection's listings names as dirty (S2): the
 * first push after the switch goes on, and the hourly full reconciliation. Held rows are queued too;
 * the push decides, at send time, what is held. Returns how many variants were queued. */
export async function queueAllMappedTikTokStock(db: Database, connectionId: string, source: "enable" | "reconcile"): Promise<number> {
  const rows = await db.execute<{ variant_sku: string }>(sql`
    insert into tiktok_stock_outbox (variant_sku, source)
    select distinct m.variant_sku, ${source}
    from tiktok_listing_skus l join tiktok_sku_mappings m on m.tiktok_sku_id = l.tiktok_sku_id and m.is_active
    where l.connection_id = ${connectionId}::uuid
    returning variant_sku
  `);
  return rows.length;
}

/** Whether the active connection has the stock switch on (S2's push checks this). */
export async function tiktokStockSyncEnabled(db: Database): Promise<boolean> {
  const rows = await db.execute<{ enabled: boolean }>(sql`select stock_sync_enabled and orders_apply_enabled as enabled from tiktok_shop_connections where status = 'active' limit 1`);
  return rows[0]?.enabled === true;
}

// ---- Preview (the Sinkron stok tab) -------------------------------------------------------------

export type TikTokStockPreviewState =
  /** Would be sent: the target differs from TikTok's quantity. */
  | "change"
  /** Target equals TikTok's quantity: nothing to send. */
  | "same"
  /** Mapped, but held for a reason (listing or variant). */
  | "held"
  /** seller_sku matches no Ammari variant: never touched (decision 3). */
  | "unmapped";

export interface TikTokStockPreviewRow {
  tiktokSkuId: string;
  tiktokProductId: string;
  productTitle: string | null;
  skuLabel: string | null;
  sellerSku: string | null;
  productStatus: string;
  variant: { sku: string; productName: string; colorName: string; size: Size } | null;
  warehouseId: string | null;
  tiktokQuantity: number | null;
  /** What would be sent; null when held or unmapped. */
  target: number | null;
  breakdown: { physical: number; checkoutHolds: number; heldTikTokOrders: number } | null;
  state: TikTokStockPreviewState;
  holdReason: TikTokListingHoldReason | TikTokTargetHoldReason | null;
  readAt: Date;
}

export interface TikTokStockPreview {
  connectionId: string | null;
  rows: TikTokStockPreviewRow[];
  counts: Record<TikTokStockPreviewState, number>;
  /** Held TikTok orders with a line no mapping attributes to a variant (not subtracted anywhere). */
  unattributedHeldOrders: number;
  /** Held TikTok orders whose lines cannot be read: every mapped row is held while there is one. */
  unreadableHeldOrders: number;
  /** Listing SKUs of the connection; `rows` holds at most the limit of them (`truncated`). */
  total: number;
  truncated: boolean;
  /** The read pass (cursor `products`). */
  lastReadOkAt: Date | null;
  lastReadRunAt: Date | null;
  lastReadErrorCode: string | null;
}

export const TIKTOK_STOCK_PREVIEW_LIMIT = 1000;

/** Every listing SKU of the current connection with its target computed now, the same way S2 will
 * compute it at push time (computeTikTokTargetQuantity). Read only. */
export async function getTikTokStockSyncPreview(db: Database, options: { connectionId: string | null; limit?: number }): Promise<TikTokStockPreview> {
  const [cursor] = await db.execute<{ last_ok_at: string | Date | null; last_run_at: string | Date | null; last_error_code: string | null }>(
    sql`select last_ok_at, last_run_at, last_error_code from tiktok_sync_cursors where resource = 'products'`,
  );
  const empty: TikTokStockPreview = {
    connectionId: options.connectionId,
    rows: [],
    counts: { change: 0, same: 0, held: 0, unmapped: 0 },
    unattributedHeldOrders: 0,
    unreadableHeldOrders: 0,
    total: 0,
    truncated: false,
    lastReadOkAt: cursor?.last_ok_at ? new Date(cursor.last_ok_at) : null,
    lastReadRunAt: cursor?.last_run_at ? new Date(cursor.last_run_at) : null,
    lastReadErrorCode: cursor?.last_error_code ?? null,
  };
  if (!options.connectionId) return empty;

  const listings = await db.execute<{
    tiktok_sku_id: string;
    tiktok_product_id: string;
    product_title: string | null;
    sku_label: string | null;
    seller_sku: string | null;
    product_status: string;
    variant_sku: string | null;
    product_name: string | null;
    color_name: string | null;
    size: Size | null;
    warehouse_id: string | null;
    tiktok_quantity: number | null;
    hold_reason: string | null;
    read_at: string | Date;
  }>(sql`
    select l.tiktok_sku_id, l.tiktok_product_id, l.product_title, l.sku_label, l.seller_sku, l.product_status, l.variant_sku,
           p.name as product_name, fc.name as color_name, pv.size, l.warehouse_id, l.tiktok_quantity, l.hold_reason, l.read_at
    from tiktok_listing_skus l
    left join product_variants pv on pv.sku = l.variant_sku
    left join products p on p.id = pv.product_id
    left join fabric_colors fc on fc.id = pv.fabric_color_id
    where l.connection_id = ${options.connectionId}::uuid
    order by (l.variant_sku is null), l.product_title nulls last, l.tiktok_product_id, l.seller_sku nulls last, l.tiktok_sku_id
    limit ${options.limit ?? TIKTOK_STOCK_PREVIEW_LIMIT}
  `);
  const variants = [...new Set(listings.map((row) => row.variant_sku).filter((sku): sku is string => sku !== null))];
  const [count] = await db.execute<{ total: number }>(sql`select count(*)::int as total from tiktok_listing_skus where connection_id = ${options.connectionId}::uuid`);
  const total = Number(count?.total ?? 0);
  const inputs = await loadTikTokTargetInputs(db, variants);
  const held = inputs.held;

  const preview: TikTokStockPreview = { ...empty, unattributedHeldOrders: held.unattributedOrders.length, unreadableHeldOrders: held.unreadableOrders.length, total, truncated: total > listings.length };
  for (const row of listings) {
    const listingHold = holdOf(row.hold_reason);
    const base = {
      tiktokSkuId: row.tiktok_sku_id,
      tiktokProductId: row.tiktok_product_id,
      productTitle: row.product_title,
      skuLabel: row.sku_label,
      sellerSku: row.seller_sku,
      productStatus: row.product_status,
      variant: row.variant_sku && row.product_name && row.color_name && row.size ? { sku: row.variant_sku, productName: row.product_name, colorName: row.color_name, size: row.size } : null,
      warehouseId: row.warehouse_id,
      tiktokQuantity: row.tiktok_quantity === null ? null : Number(row.tiktok_quantity),
      readAt: new Date(row.read_at),
    };
    let result: TikTokStockPreviewRow;
    if (!row.variant_sku || listingHold === "unmapped") {
      result = { ...base, target: null, breakdown: null, state: "unmapped", holdReason: "unmapped" };
    } else {
      const target = tiktokTargetFor(inputs, row.variant_sku);
      // The listing's own hold comes first; the target is still shown when it could be computed.
      const quantity = target.kind === "push" ? target.quantity : null;
      const breakdown = target.kind === "push" ? target.breakdown : null;
      if (listingHold) result = { ...base, target: null, breakdown, state: "held", holdReason: listingHold };
      else if (target.kind === "hold") result = { ...base, target: null, breakdown: null, state: "held", holdReason: target.reason };
      else result = { ...base, target: quantity, breakdown, state: quantity === base.tiktokQuantity ? "same" : "change", holdReason: null };
    }
    preview.counts[result.state] += 1;
    preview.rows.push(result);
  }
  return preview;
}

// ---- Target inputs (shared by the preview and the push) -------------------------------------------

export interface TikTokTargetInputs {
  /** The database clock, the one every `expires_at > now()` comparison reads. */
  now: Date;
  physical: Map<string, number>;
  holds: Map<string, TikTokCheckoutHold[]>;
  held: TikTokHeldOrderQuantities;
}

/** Everything computeTikTokTargetQuantity needs for `variants`, read now from the tables (decision 1,
 * R2): the ledger, the active checkout holds, and the paid TikTok orders not applied in admin through
 * the active mappings. The preview and the push both call this, so the owner sees what will be sent. */
export async function loadTikTokTargetInputs(db: Database, variants: readonly string[]): Promise<TikTokTargetInputs> {
  const [clock] = await db.execute<{ now: string | Date }>(sql`select now() as now`);
  if (!clock) throw new Error("loadTikTokTargetInputs: no database clock");
  const physical = new Map<string, number>();
  const holds = new Map<string, TikTokCheckoutHold[]>();
  if (variants.length > 0) {
    const list = sql.join(variants.map((sku) => sql`${sku}`), sql`, `);
    const ledger = await db.execute<{ sku: string; qty: number }>(sql`select sku, coalesce(sum(qty), 0)::int as qty from stock_movements where sku in (${list}) group by sku`);
    for (const row of ledger) physical.set(row.sku, Number(row.qty));
    const rows = await db.execute<{ sku: string; qty: number; expires_at: string | Date }>(sql`select sku, qty, expires_at from stock_reservations where status = 'active' and sku in (${list})`);
    for (const row of rows) {
      const entries = holds.get(row.sku) ?? [];
      entries.push({ qty: Number(row.qty), status: "active", expiresAt: new Date(row.expires_at) });
      holds.set(row.sku, entries);
    }
  }
  // R2: paid TikTok orders not applied in admin, through the active mappings.
  const heldOrders = await db.execute<{ tiktok_order_id: string; status: string; paid: boolean; applied: boolean; apply_state: string | null; payload: AllowlistedObject }>(sql`
    select o.tiktok_order_id, o.status, o.paid_time is not null as paid, o.order_id is not null as applied, o.apply_state, s.payload
    from tiktok_orders o join tiktok_order_snapshots s on s.id = o.latest_snapshot_id
    where o.order_id is null and o.paid_time is not null and o.status not in ('UNPAID', 'CANCELLED')
  `);
  const mappingRows = await db.execute<{ tiktok_sku_id: string; variant_sku: string }>(sql`select tiktok_sku_id, variant_sku from tiktok_sku_mappings where is_active`);
  const held = tiktokHeldOrderQuantities(
    heldOrders.map((row) => ({ tiktokOrderId: row.tiktok_order_id, status: row.status, paid: row.paid, applied: row.applied, applyState: row.apply_state, payload: row.payload })),
    new Map(mappingRows.map((row) => [row.tiktok_sku_id, row.variant_sku])),
  );
  return { now: new Date(clock.now), physical, holds, held };
}

/** The target of one variant from loaded inputs. An unreadable held order holds every variant. */
export function tiktokTargetFor(inputs: TikTokTargetInputs, variantSku: string): TikTokTargetResult {
  return computeTikTokTargetQuantity({
    physicalQty: inputs.physical.get(variantSku) ?? 0,
    holds: inputs.holds.get(variantSku) ?? [],
    heldTikTokQty: inputs.held.byVariant.get(variantSku) ?? 0,
    heldTikTokUnclear: inputs.held.unreadableOrders.length > 0 || inputs.held.unclearVariants.has(variantSku),
    now: inputs.now,
  });
}
