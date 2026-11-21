import "server-only";
import { and, count, desc, eq, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { fabricColors, fabrics, fabricStockMovements, staffUsers } from "@ammari/db/schema";
import type { RawMaterialMovementRefType, RawMaterialMovementType, StockAdjustmentReason } from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { lockFabricForUpdate } from "./db";
import { valueDeltaForConsumption, type RawMaterialBalance } from "@ammari/commerce/moving-average";

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
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: FabricWithBalanceRow[]; pagination: Pagination }> {
  const where = filters.q ? ilike(fabrics.name, `%${filters.q}%`) : undefined;

  const [totalCountRow] = await db.select({ totalCount: count() }).from(fabrics).where(where);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });

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

// ---------- Per-colour buckets (docs/plans/fabric-colour-stock.md D1/D2, migration 0046) ----------
// Stock AND the moving average live per (fabric_id, fabric_color_id) bucket; a NULL colour is the
// "Tanpa warna" bucket (every row from before colours were tracked). getFabricBalance above stays
// the fabric's TOTAL (the sum of every bucket). A write that decides on a bucket balance must hold
// the fabric row lock first (lockFabricForUpdate, D3), exactly like the total.

/** `null` = the "Tanpa warna" bucket. */
export type FabricColorBucket = string | null;

function bucketCondition(fabricId: string, fabricColorId: FabricColorBucket) {
  return and(
    eq(fabricStockMovements.fabricId, fabricId),
    fabricColorId === null ? isNull(fabricStockMovements.fabricColorId) : eq(fabricStockMovements.fabricColorId, fabricColorId),
  );
}

/** One bucket's balance: qty in yards and total value; the bucket's moving-average cost per yard is
 * valueAmount / qty (never stored), the pool every consumption from this bucket is valued at (A1).
 * At qty <= 0 there is no average — never divide; value a consumption only through
 * valueDeltaForConsumption (its zero-residual rule). Does NOT check that the colour belongs to the
 * fabric (a foreign colour simply reads 0): a write path must validate ownership first, or its
 * "stok tidak cukup" message would be misleading (the composite FKs still refuse the write). */
export async function getFabricColorBalance(
  fabricId: string,
  fabricColorId: FabricColorBucket,
  db: Database = defaultDb,
): Promise<RawMaterialBalance> {
  const [row] = await db
    .select({
      qty: sql<string>`coalesce(sum(${fabricStockMovements.qty}), 0)`,
      valueAmount: sql<string>`coalesce(sum(${fabricStockMovements.valueAmount}), 0)::bigint`,
    })
    .from(fabricStockMovements)
    .where(bucketCondition(fabricId, fabricColorId));
  return { qty: Number(row?.qty ?? 0), valueAmount: Number(row?.valueAmount ?? 0) };
}

export interface FabricColorBalanceRow extends RawMaterialBalance {
  /** `null` = "Tanpa warna". */
  fabricColorId: FabricColorBucket;
  /** `null` only for the "Tanpa warna" bucket. */
  name: string | null;
  hex: string | null;
  /** Always true for "Tanpa warna" (it is not a master row and cannot be deactivated). */
  isActive: boolean;
  /** Whether any ledger row exists for this bucket (a colour can sit at 0 after movements). */
  hasMovements: boolean;
}

/** Every bucket of one fabric worth showing: each ACTIVE colour (even with no movement yet), each
 * inactive colour that has ledger history, and "Tanpa warna" only when it has ledger history.
 * Colours by name, "Tanpa warna" last. `valueAmount` is cost data — the caller strips it for a
 * session without finance.view_profit, same discipline as listFabricsWithBalance. */
export async function listFabricColorBalances(fabricId: string, db: Database = defaultDb): Promise<FabricColorBalanceRow[]> {
  return (await listFabricColorBalancesByFabric([fabricId], db)).get(fabricId) ?? [];
}

/** listFabricColorBalances for many fabrics at once (the /stock/fabrics page): two queries total,
 * whatever the number of fabrics, never one per fabric. Every requested id is a key (possibly an
 * empty list). */
export async function listFabricColorBalancesByFabric(
  fabricIds: string[],
  db: Database = defaultDb,
): Promise<Map<string, FabricColorBalanceRow[]>> {
  const result = new Map<string, FabricColorBalanceRow[]>(fabricIds.map((id) => [id, []]));
  if (fabricIds.length === 0) return result;

  const [colors, buckets] = await Promise.all([
    db
      .select({
        id: fabricColors.id,
        fabricId: fabricColors.fabricId,
        name: fabricColors.name,
        hex: fabricColors.hex,
        isActive: fabricColors.isActive,
      })
      .from(fabricColors)
      .where(inArray(fabricColors.fabricId, fabricIds))
      .orderBy(fabricColors.name, fabricColors.id),
    db
      .select({
        fabricId: fabricStockMovements.fabricId,
        fabricColorId: fabricStockMovements.fabricColorId,
        qty: sql<string>`sum(${fabricStockMovements.qty})`,
        valueAmount: sql<string>`sum(${fabricStockMovements.valueAmount})::bigint`,
      })
      .from(fabricStockMovements)
      .where(inArray(fabricStockMovements.fabricId, fabricIds))
      .groupBy(fabricStockMovements.fabricId, fabricStockMovements.fabricColorId),
  ]);

  // Keyed "<fabricId>:<colorId|none>": a colour id is unique on its own, but the Tanpa warna
  // bucket (NULL) exists once per fabric.
  const bucketKey = (fabricId: string, fabricColorId: FabricColorBucket) => `${fabricId}:${fabricColorId ?? "none"}`;
  const balanceByBucket = new Map<string, RawMaterialBalance>(
    buckets.map((bucket) => [
      bucketKey(bucket.fabricId, bucket.fabricColorId),
      { qty: Number(bucket.qty), valueAmount: Number(bucket.valueAmount) },
    ]),
  );
  for (const color of colors) {
    const balance = balanceByBucket.get(bucketKey(color.fabricId, color.id));
    if (!color.isActive && !balance) continue;
    result.get(color.fabricId)?.push({
      fabricColorId: color.id,
      name: color.name,
      hex: color.hex,
      isActive: color.isActive,
      hasMovements: balance !== undefined,
      qty: balance?.qty ?? 0,
      valueAmount: balance?.valueAmount ?? 0,
    });
  }
  for (const fabricId of fabricIds) {
    const colorless = balanceByBucket.get(bucketKey(fabricId, null));
    if (colorless) {
      result.get(fabricId)?.push({ fabricColorId: null, name: null, hex: null, isActive: true, hasMovements: true, ...colorless });
    }
  }
  return result;
}

/** Whether an adjustment may target this bucket (the "Sesuaikan stok" colour picker and
 * recordFabricAdjustment share this rule, docs/plans/fabric-colour-stock.md S4):
 *   - an ACTIVE colour: always;
 *   - an inactive colour: only while its bucket is non-zero (it still holds stock to correct);
 *   - "Tanpa warna": when the fabric has no active colour at all, or while that bucket is non-zero
 *     (old stock to count down, or a negative bucket left by a rollback to repair).
 * A colour from another fabric never reaches here (the caller validates ownership first). */
export function isAdjustableBucket(bucket: Pick<FabricColorBalanceRow, "fabricColorId" | "isActive" | "qty">, fabricHasActiveColors: boolean): boolean {
  if (bucket.fabricColorId === null) return !fabricHasActiveColors || bucket.qty !== 0;
  return bucket.isActive || bucket.qty !== 0;
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
  /** The movement's bucket; `null` = "Tanpa warna". */
  fabricColorId: FabricColorBucket;
  colorName: string | null;
  colorHex: string | null;
  /** Meaningless (true) for "Tanpa warna". */
  colorIsActive: boolean;
  /** Running balance of whatever the ledger is filtered to: the fabric total when unfiltered,
   * that one bucket when filtered by colour. */
  runningQty: number;
  runningValueAmount: number;
}

/** The ledger "Warna" filter as it travels in the URL (`?warna=<colour id>|tanpa`). Anything
 * else (missing, malformed) means "every colour", never an error: it is only a view filter. */
export function parseFabricColorFilter(raw: string | undefined): FabricColorBucket | undefined {
  if (raw === "tanpa") return null;
  if (raw && UUID_PATTERN.test(raw)) return raw.toLowerCase();
  return undefined;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `filter.color`: undefined = every bucket (running balance = fabric total), a colour id or
 * `null` (Tanpa warna) = that bucket only (running balance = that bucket). */
export async function listFabricStockLedger(
  fabricId: string,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
  filter: { color?: FabricColorBucket } = {},
): Promise<{ rows: FabricStockLedgerRow[]; pagination: Pagination }> {
  const where = filter.color === undefined ? eq(fabricStockMovements.fabricId, fabricId) : bucketCondition(fabricId, filter.color);
  const [totalCountRow] = await db
    .select({ totalCount: count() })
    .from(fabricStockMovements)
    .where(where);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });

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
      fabricColorId: fabricStockMovements.fabricColorId,
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
    .where(where)
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
      fabricColorId: windowed.fabricColorId,
      colorName: fabricColors.name,
      colorHex: fabricColors.hex,
      colorIsActive: sql<boolean>`coalesce(${fabricColors.isActive}, true)`,
      runningQty: sql<string>`${windowed.totalQty} - ${windowed.cumQtyFromNewest} + ${windowed.qty}`,
      runningValueAmount: sql<string>`${windowed.totalValue} - ${windowed.cumValueFromNewest} + ${windowed.valueAmount}`,
    })
    .from(windowed)
    .leftJoin(staffUsers, eq(staffUsers.id, windowed.createdByStaffUserId))
    .leftJoin(fabricColors, eq(fabricColors.id, windowed.fabricColorId))
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
    // A receipt against a purchase document is reversed through its receipt ("Batalkan
    // penerimaan", lib/receipts/queries.ts), never here — otherwise there would be two ways to
    // reverse the same thing, one bypassing the receipt document (plan §6, "Legacy purchases").
    if (original.refType === "goods_receipt") {
      throw new ActionError('Pembelian ini berasal dari penerimaan barang. Gunakan "Batalkan penerimaan" di halaman pesanan pembelian.');
    }

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
        // Same colour bucket as the original (migration 0046) — see reverseGoodsReceipt.
        fabricColorId: original.fabricColorId,
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
  /** The bucket being corrected; `null` = "Tanpa warna". Must pass isAdjustableBucket. */
  fabricColorId: FabricColorBucket;
  deltaQty: number;
  reason: StockAdjustmentReason;
  note?: string | null;
}

/** numeric(10,2): at most 2 decimals and |qty| < 10^8. Enforced here too (not only by the action's
 * zod schema) so a direct caller can neither write a value Postgres silently rounds (-0.004 →
 * -0.00, passing the negative check on the unrounded number) nor hit a numeric overflow. */
function assertAdjustmentDelta(deltaQty: number) {
  if (!Number.isFinite(deltaQty) || deltaQty === 0) throw new FieldError("deltaQty", "Jumlah tidak boleh 0.");
  if (Math.round(deltaQty * 100) / 100 !== deltaQty) throw new FieldError("deltaQty", "Maksimal 2 desimal.");
  if (Math.abs(deltaQty) >= MAX_ADJUSTMENT_YARDS) throw new FieldError("deltaQty", "Jumlah terlalu besar.");
}

/** numeric(10,2)'s bound (exclusive). */
export const MAX_ADJUSTMENT_YARDS = 100_000_000;

/** A manual stock correction of ONE colour bucket (docs/plans/fabric-colour-stock.md S4, A1):
 * checked against and valued at that bucket's own balance/moving average (zero-residual rule
 * included), never the fabric total's. No adjustment may leave its bucket below zero, even when
 * the fabric total would stay positive (another colour's stock is not this colour's). */
export async function recordFabricAdjustment(
  input: RecordFabricAdjustmentInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  assertAdjustmentDelta(input.deltaQty);
  return db.transaction(async (tx) => {
    const fabric = await lockFabricForUpdate(tx, input.fabricId);
    if (!fabric) throw new ActionError("Bahan tidak ditemukan.");

    // FOR SHARE on the colour rows (the fabric lock above does not cover them: setFabricColorActive
    // never takes it): a concurrent (de)activation of one of this fabric's colours waits for this
    // decision instead of changing which buckets are adjustable underneath it.
    const colors = await tx
      .select({ id: fabricColors.id, name: fabricColors.name, isActive: fabricColors.isActive })
      .from(fabricColors)
      .where(eq(fabricColors.fabricId, input.fabricId))
      .for("share");
    const color = input.fabricColorId === null ? null : colors.find((candidate) => candidate.id === input.fabricColorId);
    if (color === undefined) throw new FieldError("fabricColorId", "Warna tidak ditemukan untuk bahan ini.");
    const colorLabel = color?.name ?? "Tanpa warna";

    const balance = await getFabricColorBalance(input.fabricId, input.fabricColorId, tx);
    const fabricHasActiveColors = colors.some((candidate) => candidate.isActive);
    const adjustable = isAdjustableBucket(
      { fabricColorId: input.fabricColorId, isActive: color?.isActive ?? true, qty: balance.qty },
      fabricHasActiveColors,
    );
    if (!adjustable) {
      throw new FieldError(
        "fabricColorId",
        color === null ? `Pilih warna untuk ${fabric.name}.` : `Warna ${colorLabel} sudah nonaktif dan tidak punya stok.`,
      );
    }

    // numeric(10,2) arithmetic in floats: round to cents before comparing (0.1 + 0.2 style).
    const newQty = Math.round((balance.qty + input.deltaQty) * 100) / 100;
    if (newQty < 0) {
      throw new FieldError(
        "deltaQty",
        `Stok ${colorLabel} tidak boleh menjadi negatif (stok sekarang ${balance.qty.toFixed(2)} yard).`,
      );
    }

    // Exactly -balance.qty when the bucket empties, so the zero-residual rule fires on an exact 0.
    const valueAmount = valueDeltaForConsumption(balance, newQty === 0 ? -balance.qty : input.deltaQty);

    const [movement] = await tx
      .insert(fabricStockMovements)
      .values({
        fabricId: input.fabricId,
        fabricColorId: input.fabricColorId,
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

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "adjust",
      entityType: "fabric_stock_movement",
      entityId: movement.id,
      after: { ...movement, colorName: colorLabel },
    });
    return movement;
  });
}
