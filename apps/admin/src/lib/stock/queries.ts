import "server-only";
import { and, asc, count, desc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  fabricColors,
  goodsReceiptItems,
  orders,
  productionBatchItems,
  products,
  productVariants,
  staffUsers,
  stockMovements,
  stockReservations,
} from "@ammari/db/schema";
import type { Size, StockAdjustmentReason } from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";
import { activeReservedQtySql } from "@ammari/db/stock-availability";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { defaultDb, type Database } from "@/lib/db";

// Read-only, admin-screen queries (overview, SKU detail + ledger, count sheet). The stock WRITE
// path (adjustStock, saveStockCount, lockVariantForUpdate, currentBalanceForSkuLocked) lives in
// @ammari/commerce/stock (docs/plans/cart-checkout.md D1) so web checkout shares it.

// ---------- Overview ----------

export type ActiveFilter = "active" | "inactive" | undefined;

export interface StockOverviewRow {
  sku: string;
  size: Size;
  minStockQty: number;
  isActive: boolean;
  colorName: string;
  colorHex: string | null;
  productId: string;
  productName: string;
  currentStock: number;
}

export interface ListStockOverviewFilters {
  q?: string;
  productId?: string;
  colorId?: string;
  size?: Size;
  lowStockOnly?: boolean;
  activeFilter?: ActiveFilter;
}

/** One query, one aggregate subquery (SUM(qty) GROUP BY sku), one join — no N+1 regardless of
 * how many SKUs exist. Shows ALL variants (active and inactive, filterable via `activeFilter`,
 * default "all") since a deactivated SKU's existing physical stock doesn't stop existing just
 * because it's no longer sold. */
export async function listStockOverview(
  filters: ListStockOverviewFilters,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: StockOverviewRow[]; pagination: Pagination }> {
  const stockBySku = db
    .select({ sku: stockMovements.sku, currentStock: sql<number>`sum(${stockMovements.qty})::int`.as("current_stock") })
    .from(stockMovements)
    .groupBy(stockMovements.sku)
    .as("stock_by_sku");

  const conditions = [
    filters.q ? or(ilike(products.name, `%${filters.q}%`), ilike(productVariants.sku, `%${filters.q}%`)) : undefined,
    filters.productId ? eq(products.id, filters.productId) : undefined,
    filters.colorId ? eq(fabricColors.id, filters.colorId) : undefined,
    filters.size ? eq(productVariants.size, filters.size) : undefined,
    filters.activeFilter === "active" ? eq(productVariants.isActive, true) : undefined,
    filters.activeFilter === "inactive" ? eq(productVariants.isActive, false) : undefined,
    filters.lowStockOnly
      ? sql`${productVariants.minStockQty} > 0 and coalesce(${stockBySku.currentStock}, 0) <= ${productVariants.minStockQty}`
      : undefined,
  ].filter((c) => c !== undefined);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalCountRow] = await db
    .select({ totalCount: count() })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .leftJoin(stockBySku, eq(stockBySku.sku, productVariants.sku))
    .where(where);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });

  const rows = await db
    .select({
      sku: productVariants.sku,
      size: productVariants.size,
      minStockQty: productVariants.minStockQty,
      isActive: productVariants.isActive,
      colorName: fabricColors.name,
      colorHex: fabricColors.hex,
      productId: products.id,
      productName: products.name,
      currentStock: sql<number>`coalesce(${stockBySku.currentStock}, 0)`,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .leftJoin(stockBySku, eq(stockBySku.sku, productVariants.sku))
    .where(where)
    .orderBy(products.name, fabricColors.name, productVariants.size)
    .limit(pagination.limit)
    .offset(pagination.offset);

  return { rows, pagination };
}

// ---------- SKU detail + ledger ----------

export interface StockLedgerRow {
  id: string;
  qty: number;
  type: string;
  refType: string;
  refId: string | null;
  note: string | null;
  reason: StockAdjustmentReason | null;
  createdAt: Date;
  createdByName: string | null;
  runningBalance: number;
  /** The ledger's "link to the production batch": resolved from ref_id for ref_type
   * 'production_batch_item' (legacy at-posting rows, ref_id = the batch ITEM's id) and
   * 'goods_receipt_item' (receipt rows since S4, through the receipt item's batch line). */
  productionBatchId: string | null;
}

export interface SkuDetail {
  sku: string;
  size: string;
  minStockQty: number;
  isActive: boolean;
  colorName: string;
  colorHex: string | null;
  productId: string;
  productName: string;
  currentStock: number;
}

export async function getSkuDetail(sku: string, db: Database = defaultDb): Promise<SkuDetail | null> {
  const [row] = await db
    .select({
      sku: productVariants.sku,
      size: productVariants.size,
      minStockQty: productVariants.minStockQty,
      isActive: productVariants.isActive,
      colorName: fabricColors.name,
      colorHex: fabricColors.hex,
      productId: products.id,
      productName: products.name,
      // Hardened to use `qualifiedColumn()` (2026-10-15 incident) rather than bare
      // `${table.column}` interpolation for this correlation — see that helper's doc comment
      // (@ammari/db/sql-helpers) for the confirmed drizzle-orm 0.45.3 behavior this avoids. This
      // specific query was NOT actually producing a wrong number (the two `innerJoin`s below
      // happen to make drizzle qualify every column correctly here), but its correctness
      // shouldn't depend on an incidental join staying present forever.
      currentStock: sql<number>`coalesce((select sum(${qualifiedColumn(stockMovements, stockMovements.qty)})::int from ${stockMovements} where ${qualifiedColumn(stockMovements, stockMovements.sku)} = ${qualifiedColumn(productVariants, productVariants.sku)}), 0)`,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(productVariants.sku, sku))
    .limit(1);
  return row ?? null;
}

/** One windowed query, no per-row application loop: `cum_from_newest` is a running total from
 * the newest movement down to each row (ROWS, not the default RANGE, so two movements sharing a
 * `created_at` tick never get double-counted into the same peer group); `total_stock` is the
 * SKU's current balance. `running_balance = total_stock - cum_from_newest + qty` is computed in
 * the outer SELECT, still inside the database — no loop over individual movements in app code. */
export async function listStockLedger(
  sku: string,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: StockLedgerRow[]; pagination: Pagination }> {
  const [totalCountRow] = await db.select({ totalCount: count() }).from(stockMovements).where(eq(stockMovements.sku, sku));
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });

  const windowed = db
    .select({
      id: stockMovements.id,
      qty: stockMovements.qty,
      type: stockMovements.type,
      refType: stockMovements.refType,
      refId: stockMovements.refId,
      note: stockMovements.note,
      reason: stockMovements.reason,
      createdAt: stockMovements.createdAt,
      createdByStaffUserId: stockMovements.createdByStaffUserId,
      // Cast applied to the WHOLE window expression (wrapped in parens) — `sum(x)::int over
      // (...)` is not valid Postgres grammar; `OVER` must directly follow the aggregate call.
      cumFromNewest: sql<number>`(sum(${stockMovements.qty}) over (order by ${stockMovements.createdAt} desc, ${stockMovements.id} desc rows between unbounded preceding and current row))::int`.as(
        "cum_from_newest",
      ),
      totalStock: sql<number>`(sum(${stockMovements.qty}) over ())::int`.as("total_stock"),
    })
    .from(stockMovements)
    .where(eq(stockMovements.sku, sku))
    .as("windowed");

  const receiptBatchItems = alias(productionBatchItems, "receipt_batch_items");
  const rows = await db
    .select({
      id: windowed.id,
      qty: windowed.qty,
      type: windowed.type,
      refType: windowed.refType,
      refId: windowed.refId,
      note: windowed.note,
      reason: windowed.reason,
      createdAt: windowed.createdAt,
      createdByName: staffUsers.name,
      runningBalance: sql<number>`${windowed.totalStock} - ${windowed.cumFromNewest} + ${windowed.qty}`,
      productionBatchId: sql<string | null>`coalesce(${productionBatchItems.productionBatchId}, ${receiptBatchItems.productionBatchId})`,
    })
    .from(windowed)
    .leftJoin(staffUsers, eq(staffUsers.id, windowed.createdByStaffUserId))
    .leftJoin(
      productionBatchItems,
      // ref_id is `text` (shared across every ref_type, see stock_movements' doc comment) but
      // production_batch_items.id is `uuid` — Postgres has no implicit text<->uuid comparison,
      // so the id side is cast explicitly rather than relying on one.
      sql`${productionBatchItems.id}::text = ${windowed.refId} and ${windowed.refType} = 'production_batch_item'`,
    )
    // Since S4 a 'production' row comes from a goods receipt (ref_type 'goods_receipt_item',
    // reversals included): resolve it through the receipt item's batch line. Legacy at-posting
    // rows keep resolving through the join above.
    // The uuid side stays uncast so the PK index is used; CASE guarantees ref_id is only cast for
    // this ref_type (an AND gives no evaluation-order guarantee, and other ref_ids may not be uuids).
    .leftJoin(
      goodsReceiptItems,
      sql`${goodsReceiptItems.id} = case when ${windowed.refType} = 'goods_receipt_item' then ${windowed.refId}::uuid end`,
    )
    .leftJoin(receiptBatchItems, eq(receiptBatchItems.id, goodsReceiptItems.productionBatchItemId))
    .orderBy(desc(windowed.createdAt), desc(windowed.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return { rows, pagination };
}

export async function listProductSkusForCount(productId: string, db: Database = defaultDb) {
  return db
    .select({
      sku: productVariants.sku,
      size: productVariants.size,
      colorName: fabricColors.name,
      colorHex: fabricColors.hex,
      // Hardened the same way and for the same reason as getSkuDetail's own currentStock above
      // — see that function's comment and @ammari/db/sql-helpers's qualifiedColumn doc comment.
      currentStock: sql<number>`coalesce((select sum(${qualifiedColumn(stockMovements, stockMovements.qty)})::int from ${stockMovements} where ${qualifiedColumn(stockMovements, stockMovements.sku)} = ${qualifiedColumn(productVariants, productVariants.sku)}), 0)`,
    })
    .from(productVariants)
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(productVariants.productId, productId))
    .orderBy(fabricColors.name, productVariants.size);
}

export async function getProductNameAndSkus(productId: string, db: Database = defaultDb) {
  const [product] = await db.select({ id: products.id, name: products.name }).from(products).where(eq(products.id, productId)).limit(1);
  return product ?? null;
}

// ---------- Dipesan (checkout stock holds) ----------
//
// Read-only (docs/plans/cart-checkout.md §7): pieces held for unpaid web checkout orders. They
// are still on the shelf and still part of every physical figure above (currentStock, the count
// sheet's "Sistem", stock status); admin writes keep checking physical stock only (D4). Only
// active, unexpired holds count, the same rule the storefront's availability uses.

/** Held pcs per SKU. SKUs without an active hold are absent (same shape as getDefectQtyBySku). */
export async function getReservedQtyBySku(skus: readonly string[], db: Database = defaultDb): Promise<Map<string, number>> {
  if (skus.length === 0) return new Map();
  const rows = await db
    .select({
      sku: productVariants.sku,
      reservedQty: activeReservedQtySql(qualifiedColumn(productVariants, productVariants.sku)),
    })
    .from(productVariants)
    .where(inArray(productVariants.sku, [...skus]));
  return new Map(rows.filter((row) => row.reservedQty > 0).map((row) => [row.sku, row.reservedQty]));
}

export interface ActiveReservationRow {
  id: string;
  orderId: string;
  orderNo: string;
  qty: number;
  createdAt: Date;
  expiresAt: Date;
}

/** The orders currently holding `sku`, soonest expiry first. A hold past its expiry no longer
 * counts (and is left out) even before the sweeper marks it released. */
export async function listActiveReservationsForSku(sku: string, db: Database = defaultDb): Promise<ActiveReservationRow[]> {
  return db
    .select({
      id: stockReservations.id,
      orderId: stockReservations.orderId,
      orderNo: orders.orderNo,
      qty: stockReservations.qty,
      createdAt: stockReservations.createdAt,
      expiresAt: stockReservations.expiresAt,
    })
    .from(stockReservations)
    .innerJoin(orders, eq(orders.id, stockReservations.orderId))
    .where(and(eq(stockReservations.sku, sku), eq(stockReservations.status, "active"), gt(stockReservations.expiresAt, sql`now()`)))
    .orderBy(asc(stockReservations.expiresAt), asc(stockReservations.id));
}
