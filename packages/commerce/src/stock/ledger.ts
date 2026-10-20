import "server-only";
import { eq, sql } from "drizzle-orm";
import { productVariants, stockMovements } from "@ammari/db/schema";
import type { StockAdjustmentReason } from "@ammari/db/schema";
import { ActionError, FieldError } from "../errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "../db";
import { valueDeltaForConsumption } from "../inventory/moving-average";
import { lockVariantForUpdate } from "./lock";

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

    const balance = await currentBalanceForSkuLocked(tx, input.sku);
    const newStock = balance.qty + input.deltaQty;
    if (newStock < 0) throw new FieldError("deltaQty", "Stok tidak boleh menjadi negatif.");

    // Same moving-average treatment a raw-material adjustment already gets (reused unchanged
    // from ../inventory/moving-average.ts): valued AT the current average, with the "qty hits
    // exactly 0 clears the remaining value" correction baked in — never a separately-rounded
    // qty*average that could strand a few rupiah of value at zero stock.
    const valueAmount = valueDeltaForConsumption(balance, input.deltaQty);

    const [movement] = await tx
      .insert(stockMovements)
      .values({
        sku: input.sku,
        qty: input.deltaQty,
        valueAmount,
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
 * anything, it just recomputes the balance once that lock makes it safe to trust. Returns both
 * qty AND valueAmount (the same `{qty, valueAmount}` shape ../inventory/moving-average.ts's
 * functions expect) — finished-goods stock uses the identical moving-average idiom raw
 * materials already do, just computed over stock_movements instead of accessory_movements/
 * fabric_stock_movements. */
export async function currentBalanceForSkuLocked(tx: Tx, sku: string): Promise<{ qty: number; valueAmount: number }> {
  const [row] = await tx
    .select({
      qty: sql<number>`coalesce(sum(${stockMovements.qty}), 0)::int`,
      // NOT cast down to ::int — a bigint SUM genuinely needs the range. postgres.js returns
      // bigint (OID 20) as a STRING regardless of how it was produced — a raw `sql` fragment
      // bypasses Drizzle's typed bigint-mode "number" column mapping entirely, so this MUST be
      // converted explicitly (same idiom as apps/admin's lib/inventory/accessories.ts
      // getAccessoryBalance).
      valueAmount: sql<string>`coalesce(sum(${stockMovements.valueAmount}), 0)::bigint`,
    })
    .from(stockMovements)
    .where(eq(stockMovements.sku, sku));
  return { qty: row?.qty ?? 0, valueAmount: Number(row?.valueAmount ?? 0) };
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
      const balance = await currentBalanceForSkuLocked(tx, line.sku);
      const delta = line.physicalQty - balance.qty;
      if (delta === 0) continue;
      changedSkus.push(line.sku);
      // Same moving-average treatment as adjustStock — valued AT the current average computed
      // from THIS line's own balance (each line locks and re-reads its own SKU before valuing
      // it, so an earlier line's write in this same loop never stales a later line's balance).
      movements.push({
        sku: line.sku,
        qty: delta,
        valueAmount: valueDeltaForConsumption(balance, delta),
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
