import "server-only";
import { and, count, desc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import { fabrics, fabricStockMovements, staffUsers } from "@ammari/db/schema";
import type { RawMaterialMovementRefType, RawMaterialMovementType, StockAdjustmentReason } from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { lockFabricForUpdate } from "./db";
import { valueDeltaForConsumption, type RawMaterialBalance } from "./moving-average";

const PAGE_SIZE = 20;

// ---------- Master list with stock balance (the /stock/fabrics tab — see accessories.ts's
// listAccessories for the identical shape this mirrors) ----------

export interface FabricWithBalanceRow {
  id: string;
  name: string;
  supplier: string | null;
  qty: number;
  valueAmount: number;
}

/** `valueAmount` is always computed — same discipline as listAccessories: the CALLER strips it
 * before it reaches a session without finance.view_profit. */
export async function listFabricsWithBalance(
  filters: { q?: string },
  rawPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: FabricWithBalanceRow[]; pagination: Pagination }> {
  const where = filters.q ? ilike(fabrics.name, `%${filters.q}%`) : undefined;

  const [totalCountRow] = await db.select({ totalCount: count() }).from(fabrics).where(where);
  const pagination = resolvePagination({ rawPage, totalCount: totalCountRow?.totalCount ?? 0, pageSize: PAGE_SIZE });

  const balanceByFabric = db
    .select({
      fabricId: fabricStockMovements.fabricId,
      // numeric(10,2) SUM — comes back as a string, converted below (same reasoning as every
      // other numeric/bigint aggregate in this file).
      qty: sql<string>`sum(${fabricStockMovements.qty})`.as("qty"),
      valueAmount: sql<string>`sum(${fabricStockMovements.valueAmount})::bigint`.as("value_amount"),
    })
    .from(fabricStockMovements)
    .groupBy(fabricStockMovements.fabricId)
    .as("balance_by_fabric");

  const rows = await db
    .select({
      id: fabrics.id,
      name: fabrics.name,
      supplier: fabrics.supplier,
      qty: sql<string>`coalesce(${balanceByFabric.qty}, 0)`,
      valueAmount: sql<string>`coalesce(${balanceByFabric.valueAmount}, 0)`,
    })
    .from(fabrics)
    .leftJoin(balanceByFabric, eq(balanceByFabric.fabricId, fabrics.id))
    .where(where)
    .orderBy(fabrics.name, fabrics.id)
    .limit(pagination.limit)
    .offset(pagination.offset);

  return { rows: rows.map((row) => ({ ...row, qty: Number(row.qty), valueAmount: Number(row.valueAmount) })), pagination };
}

// Fabric MASTER CRUD (name, supplier, composition, reference price) lives in
// lib/products/fabric-queries.ts, unchanged — this file is only the stock/moving-average/
// purchase/void mechanism, identical in shape to lib/inventory/accessories.ts but keyed by
// fabric_id and in yards (numeric(10,2)) instead of whole pcs. See that file's doc comments for
// the full design reasoning (moving average without a mutable counter, correction #1's
// zero-residual rule, correction #2's void-after-later-movement rule) — not repeated here.

export async function getFabricBalance(fabricId: string, db: Database = defaultDb): Promise<RawMaterialBalance> {
  // Both SUM(numeric) and SUM(bigint) come back from postgres.js as STRINGS, not numbers — same
  // bigint-as-string class of bug as accessories.ts's getAccessoryBalance (see its comment);
  // qty here is numeric(10,2), not int4, so it needs the same explicit conversion the accessory
  // version's cast-to-::int sidesteps.
  const [row] = await db
    .select({
      qty: sql<string>`coalesce(sum(${fabricStockMovements.qty}), 0)`,
      valueAmount: sql<string>`coalesce(sum(${fabricStockMovements.valueAmount}), 0)::bigint`,
    })
    .from(fabricStockMovements)
    .where(eq(fabricStockMovements.fabricId, fabricId));
  return { qty: Number(row?.qty ?? 0), valueAmount: Number(row?.valueAmount ?? 0) };
}

export interface FabricStockLedgerRow {
  id: string;
  qty: number;
  valueAmount: number;
  type: RawMaterialMovementType;
  refType: RawMaterialMovementRefType;
  refId: string | null;
  reason: StockAdjustmentReason | null;
  supplier: string | null;
  purchasedAt: string | null;
  voidedAt: Date | null;
  note: string | null;
  createdAt: Date;
  createdByName: string | null;
  runningQty: number;
  runningValueAmount: number;
}

export async function listFabricStockLedger(
  fabricId: string,
  rawPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: FabricStockLedgerRow[]; pagination: Pagination }> {
  const [totalCountRow] = await db
    .select({ totalCount: count() })
    .from(fabricStockMovements)
    .where(eq(fabricStockMovements.fabricId, fabricId));
  const pagination = resolvePagination({ rawPage, totalCount: totalCountRow?.totalCount ?? 0, pageSize: PAGE_SIZE });

  const windowed = db
    .select({
      id: fabricStockMovements.id,
      qty: fabricStockMovements.qty,
      valueAmount: fabricStockMovements.valueAmount,
      type: fabricStockMovements.type,
      refType: fabricStockMovements.refType,
      refId: fabricStockMovements.refId,
      reason: fabricStockMovements.reason,
      supplier: fabricStockMovements.supplier,
      purchasedAt: fabricStockMovements.purchasedAt,
      voidedAt: fabricStockMovements.voidedAt,
      note: fabricStockMovements.note,
      createdAt: fabricStockMovements.createdAt,
      createdByStaffUserId: fabricStockMovements.createdByStaffUserId,
      // qty is numeric(10,2), not int4 — SUM(numeric) stays numeric, which (like bigint) comes
      // back from postgres.js as a STRING, not a number; typed `string` here and converted in
      // the final .map() below, same reasoning as every value_amount field in this file.
      cumQtyFromNewest: sql<string>`(sum(${fabricStockMovements.qty}) over (order by ${fabricStockMovements.createdAt} desc, ${fabricStockMovements.id} desc rows between unbounded preceding and current row))`.as(
        "cum_qty_from_newest",
      ),
      cumValueFromNewest: sql<string>`(sum(${fabricStockMovements.valueAmount}) over (order by ${fabricStockMovements.createdAt} desc, ${fabricStockMovements.id} desc rows between unbounded preceding and current row))::bigint`.as(
        "cum_value_from_newest",
      ),
      totalQty: sql<string>`(sum(${fabricStockMovements.qty}) over ())`.as("total_qty"),
      totalValue: sql<string>`(sum(${fabricStockMovements.valueAmount}) over ())::bigint`.as("total_value"),
    })
    .from(fabricStockMovements)
    .where(eq(fabricStockMovements.fabricId, fabricId))
    .as("windowed");

  const rows = await db
    .select({
      id: windowed.id,
      qty: windowed.qty,
      valueAmount: windowed.valueAmount,
      type: windowed.type,
      refType: windowed.refType,
      refId: windowed.refId,
      reason: windowed.reason,
      supplier: windowed.supplier,
      purchasedAt: windowed.purchasedAt,
      voidedAt: windowed.voidedAt,
      note: windowed.note,
      createdAt: windowed.createdAt,
      createdByName: staffUsers.name,
      runningQty: sql<string>`${windowed.totalQty} - ${windowed.cumQtyFromNewest} + ${windowed.qty}`,
      runningValueAmount: sql<string>`${windowed.totalValue} - ${windowed.cumValueFromNewest} + ${windowed.valueAmount}`,
    })
    .from(windowed)
    .leftJoin(staffUsers, eq(staffUsers.id, windowed.createdByStaffUserId))
    .orderBy(desc(windowed.createdAt), desc(windowed.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return {
    rows: rows.map((row) => ({
      ...row,
      qty: Number(row.qty),
      valueAmount: Number(row.valueAmount),
      runningQty: Number(row.runningQty),
      runningValueAmount: Number(row.runningValueAmount),
    })),
    pagination,
  };
}

export interface RecordFabricPurchaseInput {
  fabricId: string;
  qty: number;
  totalAmountPaid: number;
  purchasedAt: string;
  supplier?: string | null;
  note?: string | null;
}

export async function recordFabricPurchase(
  input: RecordFabricPurchaseInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  // See accessories.ts's recordAccessoryPurchase for why this must be enforced here too, not
  // just at the form layer — voidFabricPurchase's own negative-stock guard relies on it.
  if (input.qty <= 0) throw new FieldError("qty", "Jumlah harus lebih dari 0.");
  if (input.totalAmountPaid < 0) throw new FieldError("totalAmountPaid", "Total harga tidak boleh negatif.");

  return db.transaction(async (tx) => {
    const fabric = await lockFabricForUpdate(tx, input.fabricId);
    if (!fabric) throw new ActionError("Bahan tidak ditemukan.");

    const [movement] = await tx
      .insert(fabricStockMovements)
      .values({
        fabricId: input.fabricId,
        qty: input.qty,
        valueAmount: input.totalAmountPaid,
        type: "purchase",
        refType: "manual",
        purchasedAt: input.purchasedAt,
        supplier: input.supplier ?? null,
        note: input.note ?? null,
        createdByStaffUserId: actorStaffUserId,
      })
      .returning();
    if (!movement) throw new Error("failed to insert fabric stock movement");

    await writeAuditLog(tx, { actorStaffUserId, action: "purchase", entityType: "fabric_stock_movement", entityId: movement.id, after: movement });
    return movement;
  });
}

const BLOCKING_VOID_TYPES = ["production", "adjustment", "purchase_void"] as const;

/** See accessories.ts's voidAccessoryPurchase for the full design reasoning (correction #2) —
 * identical rule, same reasoning, separate table. `actorStaffUserId` is non-nullable for the
 * same reason (voided_pair_check requires voided_by_staff_user_id alongside voided_at). */
export async function voidFabricPurchase(movementId: string, actorStaffUserId: string, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const [original] = await tx.select().from(fabricStockMovements).where(eq(fabricStockMovements.id, movementId)).limit(1);
    if (!original) throw new ActionError("Transaksi pembelian tidak ditemukan.");
    if (original.type !== "purchase") throw new ActionError("Hanya transaksi pembelian yang bisa dibatalkan.");

    const fabric = await lockFabricForUpdate(tx, original.fabricId);
    if (!fabric) throw new Error("fabric not found for an existing movement");

    if (original.voidedAt !== null) throw new ActionError("Pembelian ini sudah dibatalkan sebelumnya.");

    const [laterBlocking] = await tx
      .select({ id: fabricStockMovements.id })
      .from(fabricStockMovements)
      .where(
        and(
          eq(fabricStockMovements.fabricId, original.fabricId),
          inArray(fabricStockMovements.type, BLOCKING_VOID_TYPES),
          // See accessories.ts's voidAccessoryPurchase for why this uses typed operators, not
          // raw sql or a row-constructor comparison.
          or(
            gt(fabricStockMovements.createdAt, original.createdAt),
            and(eq(fabricStockMovements.createdAt, original.createdAt), gt(fabricStockMovements.id, original.id)),
          ),
        ),
      )
      .limit(1);
    if (laterBlocking) {
      throw new ActionError(
        'Pembelian ini tidak bisa dibatalkan karena sudah ada pergerakan stok sesudahnya. Gunakan "Sesuaikan stok" untuk mengoreksi jumlahnya.',
      );
    }

    // Defensive backstop, not the primary guarantee — see voidAccessoryPurchase's identical
    // comment for why this is unreachable in practice given the later-movement check above.
    const balance = await getFabricBalance(original.fabricId, tx);
    if (balance.qty - original.qty < 0) {
      throw new ActionError("Pembatalan ini akan membuat stok menjadi negatif.");
    }

    const [voidMovement] = await tx
      .insert(fabricStockMovements)
      .values({
        fabricId: original.fabricId,
        qty: -original.qty,
        valueAmount: -original.valueAmount,
        type: "purchase_void",
        refType: "manual",
        voidsMovementId: original.id,
        createdByStaffUserId: actorStaffUserId,
      })
      .returning();
    if (!voidMovement) throw new Error("failed to insert void movement");

    const [updatedOriginal] = await tx
      .update(fabricStockMovements)
      .set({ voidedAt: new Date(), voidedByStaffUserId: actorStaffUserId })
      .where(eq(fabricStockMovements.id, original.id))
      .returning();
    if (!updatedOriginal) throw new Error("failed to mark original movement as voided");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "void",
      entityType: "fabric_stock_movement",
      entityId: original.id,
      before: original,
      after: { void: voidMovement, original: updatedOriginal },
    });
    return voidMovement;
  });
}

export interface RecordFabricAdjustmentInput {
  fabricId: string;
  deltaQty: number;
  reason: StockAdjustmentReason;
  note?: string | null;
}

export async function recordFabricAdjustment(
  input: RecordFabricAdjustmentInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    const fabric = await lockFabricForUpdate(tx, input.fabricId);
    if (!fabric) throw new ActionError("Bahan tidak ditemukan.");

    const balance = await getFabricBalance(input.fabricId, tx);
    const newQty = balance.qty + input.deltaQty;
    if (newQty < 0) throw new FieldError("deltaQty", "Stok tidak boleh menjadi negatif.");

    const valueAmount = valueDeltaForConsumption(balance, input.deltaQty);

    const [movement] = await tx
      .insert(fabricStockMovements)
      .values({
        fabricId: input.fabricId,
        qty: input.deltaQty,
        valueAmount,
        type: "adjustment",
        refType: "manual",
        reason: input.reason,
        note: input.note ?? null,
        createdByStaffUserId: actorStaffUserId,
      })
      .returning();
    if (!movement) throw new Error("failed to insert fabric stock movement");

    await writeAuditLog(tx, { actorStaffUserId, action: "adjust", entityType: "fabric_stock_movement", entityId: movement.id, after: movement });
    return movement;
  });
}
