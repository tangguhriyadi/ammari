import "server-only";
import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { fabricColors, productionBatchItems, products, productVariants, staffUsers, stockMovements } from "@ammari/db/schema";
import type { Size, StockAdjustmentReason } from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { lockVariantForUpdate } from "./db";

const PAGE_SIZE = 20;

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
  const pagination = resolvePagination({ rawPage, totalCount: totalCountRow?.totalCount ?? 0, pageSize: PAGE_SIZE });

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
  /** Resolved from ref_id only when ref_type = 'production_batch_item' — the ledger's "link to
   * the production batch" (ref_id itself is the batch ITEM's id, not the batch's). */
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
      currentStock: sql<number>`coalesce((select sum(${stockMovements.qty})::int from ${stockMovements} where ${stockMovements.sku} = ${productVariants.sku}), 0)`,
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
  db: Database = defaultDb,
): Promise<{ rows: StockLedgerRow[]; pagination: Pagination }> {
  const [totalCountRow] = await db.select({ totalCount: count() }).from(stockMovements).where(eq(stockMovements.sku, sku));
  const pagination = resolvePagination({ rawPage, totalCount: totalCountRow?.totalCount ?? 0, pageSize: PAGE_SIZE });

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
      productionBatchId: productionBatchItems.productionBatchId,
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
    .orderBy(desc(windowed.createdAt), desc(windowed.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return { rows, pagination };
}

// ---------- Manual adjustment ----------

export interface AdjustStockInput {
  sku: string;
  deltaQty: number;
  reason: StockAdjustmentReason;
  note?: string | null;
}

/** 1. `SELECT ... FOR UPDATE` the variant row FIRST — serializes concurrent adjustments on the
 * SAME sku so each one recomputes the balance AFTER any earlier one in the same race has
 * committed, instead of two readers both seeing the same stale balance.
 * 2. Recompute the current balance (now safe to trust).
 * 3. Reject if the result would go negative.
 * 4. Insert one stock_movements row (+ audit_log). */
export async function adjustStock(input: AdjustStockInput, actorStaffUserId: string, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const variant = await lockVariantForUpdate(tx, input.sku);
    if (!variant) throw new ActionError("SKU tidak ditemukan.");

    const currentStock = await currentStockForSkuLocked(tx, input.sku);
    const newStock = currentStock + input.deltaQty;
    if (newStock < 0) throw new FieldError("deltaQty", "Stok tidak boleh menjadi negatif.");

    const [movement] = await tx
      .insert(stockMovements)
      .values({
        sku: input.sku,
        qty: input.deltaQty,
        type: "adjustment",
        refType: "manual",
        reason: input.reason,
        note: input.note ?? null,
        createdByStaffUserId: actorStaffUserId,
      })
      .returning();
    if (!movement) throw new Error("failed to insert stock movement");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "adjust",
      entityType: "stock_movement",
      entityId: movement.id,
      after: movement,
    });
    return movement;
  });
}

/** Must only be called AFTER the caller has already locked `sku`'s product_variants row in the
 * SAME transaction (see adjustStock/saveStockCount) — this function itself does not lock
 * anything, it just recomputes the balance once that lock makes it safe to trust. */
async function currentStockForSkuLocked(tx: Tx, sku: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${stockMovements.qty})::int, 0)` })
    .from(stockMovements)
    .where(eq(stockMovements.sku, sku));
  return row?.total ?? 0;
}

// ---------- Stock count (opname) ----------

export interface StockCountLine {
  sku: string;
  physicalQty: number;
}

/** One transaction for the whole product's count: each changed SKU gets its own row lock (same
 * reasoning as adjustStock) and its own movement row (reason='recount'), but ALL of it commits
 * or rolls back together, with ONE audit_log entry for the whole operation — not one per SKU.
 * A SKU whose physical count matches the system count creates nothing. */
export async function saveStockCount(
  productId: string,
  lines: readonly StockCountLine[],
  actorStaffUserId: string,
  db: Database = defaultDb,
): Promise<{ changedSkus: string[] }> {
  // Defense-in-depth against a duplicate SKU in `lines` (the action's own Zod schema already
  // rejects this, but this function is also directly callable, e.g. from a future import script
  // or test) — without this, two lines for the same SKU would each check their delta against
  // the SAME pre-submission balance (movements are only inserted after the whole loop, not
  // incrementally), so their COMBINED effect is never actually validated and could drive stock
  // negative undetected even though each line looks individually safe.
  const skuCounts = new Map<string, number>();
  for (const line of lines) skuCounts.set(line.sku, (skuCounts.get(line.sku) ?? 0) + 1);
  const duplicateSku = [...skuCounts.entries()].find(([, count]) => count > 1)?.[0];
  if (duplicateSku) throw new FieldError(duplicateSku, `SKU ${duplicateSku} muncul lebih dari sekali dalam hitung stok ini.`);

  // Sorted, not in caller-submitted order — two concurrent saveStockCount calls (e.g. the same
  // product counted from two tabs) that lock overlapping SKUs in opposite orders would otherwise
  // deadlock (transaction A waits on the lock transaction B holds, and vice versa). A single
  // consistent lock order across every call makes that impossible: whichever call reaches a
  // given SKU first always proceeds, never circularly.
  const sortedLines = [...lines].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));

  return db.transaction(async (tx) => {
    const variantRows = await tx.select().from(productVariants).where(eq(productVariants.productId, productId));
    const variantBySku = new Map(variantRows.map((variant) => [variant.sku, variant]));

    const changedSkus: string[] = [];
    const movements: (typeof stockMovements.$inferInsert)[] = [];
    for (const line of sortedLines) {
      if (!variantBySku.has(line.sku)) throw new ActionError(`SKU ${line.sku} bukan milik produk ini.`);
      // Defense-in-depth — the action's Zod schema already enforces this, but a direct caller
      // of this function could bypass it.
      if (line.physicalQty < 0) throw new FieldError(line.sku, "Jumlah tidak boleh negatif.");
      await lockVariantForUpdate(tx, line.sku);
      const currentStock = await currentStockForSkuLocked(tx, line.sku);
      const delta = line.physicalQty - currentStock;
      if (delta === 0) continue;
      changedSkus.push(line.sku);
      movements.push({
        sku: line.sku,
        qty: delta,
        type: "adjustment",
        refType: "manual",
        reason: "recount",
        createdByStaffUserId: actorStaffUserId,
      });
    }

    if (movements.length > 0) {
      const inserted = await tx.insert(stockMovements).values(movements).returning();
      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "stock_count",
        entityType: "product",
        entityId: productId,
        after: { movements: inserted },
      });
    }

    return { changedSkus };
  });
}

export async function listProductSkusForCount(productId: string, db: Database = defaultDb) {
  return db
    .select({
      sku: productVariants.sku,
      size: productVariants.size,
      colorName: fabricColors.name,
      colorHex: fabricColors.hex,
      currentStock: sql<number>`coalesce((select sum(${stockMovements.qty})::int from ${stockMovements} where ${stockMovements.sku} = ${productVariants.sku}), 0)`,
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
