import "server-only";
import { and, count, desc, eq, gt, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { accessories, accessoryMovements, staffUsers } from "@ammari/db/schema";
import type { RawMaterialMovementRefType, RawMaterialMovementType, Size, StockAdjustmentReason } from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { ActionError, FieldError, mapUniqueViolation } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { lockAccessoryForUpdate } from "./db";
import { valueDeltaForConsumption, type RawMaterialBalance } from "./moving-average";

const PAGE_SIZE = 20;

const ACCESSORY_CONSTRAINT_FIELDS = {
  accessories_size_group_size_key: {
    field: "size",
    message: "Ukuran ini sudah ada di grup aksesoris yang sama.",
  },
};

// ---------- Master list ----------

export interface AccessoryInput {
  name: string;
  size?: Size | null;
  sizeGroup?: string | null;
  isActive?: boolean;
  notes?: string | null;
}

export interface AccessoryListRow {
  id: string;
  name: string;
  size: Size | null;
  sizeGroup: string | null;
  isActive: boolean;
  notes: string | null;
  qty: number;
  valueAmount: number;
}

export type AccessoryActiveFilter = "active" | "inactive" | undefined;

/** `valueAmount` is always computed (it's the same aggregate query either way) — the CALLER
 * (the page, not this function) is responsible for stripping it before it ever reaches a
 * session without finance.view_profit, same discipline Phase C's createDraftAction/
 * updateDraftAction apply for production costs. */
export async function listAccessories(
  filters: { q?: string; activeFilter?: AccessoryActiveFilter },
  rawPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: AccessoryListRow[]; pagination: Pagination }> {
  const conditions = [
    filters.q ? ilike(accessories.name, `%${filters.q}%`) : undefined,
    filters.activeFilter === "active" ? eq(accessories.isActive, true) : undefined,
    filters.activeFilter === "inactive" ? eq(accessories.isActive, false) : undefined,
  ].filter((c) => c !== undefined);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalCountRow] = await db.select({ totalCount: count() }).from(accessories).where(where);
  const pagination = resolvePagination({ rawPage, totalCount: totalCountRow?.totalCount ?? 0, pageSize: PAGE_SIZE });

  const balanceByAccessory = db
    .select({
      accessoryId: accessoryMovements.accessoryId,
      qty: sql<number>`sum(${accessoryMovements.qty})::int`.as("qty"),
      valueAmount: sql<string>`sum(${accessoryMovements.valueAmount})::bigint`.as("value_amount"),
    })
    .from(accessoryMovements)
    .groupBy(accessoryMovements.accessoryId)
    .as("balance_by_accessory");

  const rows = await db
    .select({
      id: accessories.id,
      name: accessories.name,
      size: accessories.size,
      sizeGroup: accessories.sizeGroup,
      isActive: accessories.isActive,
      notes: accessories.notes,
      qty: sql<number>`coalesce(${balanceByAccessory.qty}, 0)`,
      // STRING at the driver level (bigint SUM) — converted to a real number below, same
      // bigint-as-string reasoning as getAccessoryBalance's own doc comment.
      valueAmount: sql<string>`coalesce(${balanceByAccessory.valueAmount}, 0)`,
    })
    .from(accessories)
    .leftJoin(balanceByAccessory, eq(balanceByAccessory.accessoryId, accessories.id))
    .where(where)
    .orderBy(accessories.name, accessories.id)
    .limit(pagination.limit)
    .offset(pagination.offset);

  return { rows: rows.map((row) => ({ ...row, valueAmount: Number(row.valueAmount) })), pagination };
}

export async function getAccessoryById(id: string, db: Database = defaultDb) {
  const [row] = await db.select().from(accessories).where(eq(accessories.id, id)).limit(1);
  return row ?? null;
}

export async function listActiveAccessories(db: Database = defaultDb) {
  return db.select().from(accessories).where(eq(accessories.isActive, true)).orderBy(accessories.name);
}

/** Distinct, non-null size_group values across every accessory — feeds the accessory form's
 * datalist (correction #4, approved plan) so the owner can pick an EXISTING group instead of
 * retyping it, which is the whole reason size_group is citext in the first place: a selectable
 * list only helps if the underlying comparison already collapses case/whitespace variants. */
export async function listDistinctSizeGroups(db: Database = defaultDb): Promise<string[]> {
  const rows = await db
    .select({ sizeGroup: accessories.sizeGroup })
    .from(accessories)
    .where(isNotNull(accessories.sizeGroup))
    .groupBy(accessories.sizeGroup)
    .orderBy(accessories.sizeGroup);
  return rows.map((row) => row.sizeGroup).filter((group): group is string => group !== null);
}

export async function createAccessory(input: AccessoryInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    try {
      const [accessory] = await tx.insert(accessories).values(input).returning();
      if (!accessory) throw new Error("failed to insert accessory");
      await writeAuditLog(tx, { actorStaffUserId, action: "create", entityType: "accessory", entityId: accessory.id, after: accessory });
      return accessory;
    } catch (error) {
      mapUniqueViolation(error, ACCESSORY_CONSTRAINT_FIELDS);
    }
  });
}

export async function updateAccessory(
  id: string,
  input: AccessoryInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    const before = await getAccessoryById(id, tx);
    if (!before) throw new ActionError("Aksesoris tidak ditemukan.");
    try {
      const [after] = await tx.update(accessories).set(input).where(eq(accessories.id, id)).returning();
      if (!after) throw new Error("failed to update accessory");
      await writeAuditLog(tx, { actorStaffUserId, action: "update", entityType: "accessory", entityId: id, before, after });
      return after;
    } catch (error) {
      mapUniqueViolation(error, ACCESSORY_CONSTRAINT_FIELDS);
    }
  });
}

/** No hard delete, ever — same reasoning as cost_components/fabric_colors. The
 * accessory_movements FK (ON DELETE RESTRICT) and product_accessory_recipes FK are backstops,
 * not the primary guarantee. */
export async function setAccessoryActive(
  id: string,
  isActive: boolean,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    const before = await getAccessoryById(id, tx);
    if (!before) throw new ActionError("Aksesoris tidak ditemukan.");
    const [after] = await tx.update(accessories).set({ isActive }).where(eq(accessories.id, id)).returning();
    if (!after) throw new Error("failed to update accessory");
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: isActive ? "activate" : "deactivate",
      entityType: "accessory",
      entityId: id,
      before,
      after,
    });
    return after;
  });
}

// ---------- Stock balance ----------

/** The item's current balance, derived via a plain SUM over its ledger — NEVER a stored
 * counter (see accessory_movements' own doc comment in packages/db/src/schema/catalog.ts).
 * Safe to call with the unlocked `defaultDb` for display purposes; when used to decide whether a
 * NEW movement is safe to insert, the caller MUST have already locked the accessory row in the
 * SAME transaction first (via lockAccessoryForUpdate) — this function does not lock anything
 * itself, it only recomputes the sum once that lock makes the result safe to trust (same idiom
 * as lib/stock/queries.ts's currentStockForSkuLocked). */
export async function getAccessoryBalance(accessoryId: string, db: Database = defaultDb): Promise<RawMaterialBalance> {
  const [row] = await db
    .select({
      qty: sql<number>`coalesce(sum(${accessoryMovements.qty}), 0)::int`,
      // NOT cast down to ::int — a bigint SUM genuinely needs the range. postgres.js returns
      // bigint (OID 20) as a STRING regardless of how it was produced, to avoid silently losing
      // precision above Number.MAX_SAFE_INTEGER — unlike a typed Drizzle column (whose own
      // bigint-mode "number" mapping converts it automatically), a raw `sql` fragment bypasses
      // that mapping entirely, so this MUST be converted explicitly here (same bigint-as-string
      // class of bug this codebase avoids elsewhere by preferring typed column selects).
      valueAmount: sql<string>`coalesce(sum(${accessoryMovements.valueAmount}), 0)::bigint`,
    })
    .from(accessoryMovements)
    .where(eq(accessoryMovements.accessoryId, accessoryId));
  return { qty: row?.qty ?? 0, valueAmount: Number(row?.valueAmount ?? 0) };
}

// ---------- Ledger ----------

export interface AccessoryLedgerRow {
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

/** Same windowed-SUM technique as lib/stock/queries.ts's listStockLedger, extended to track TWO
 * running totals (qty and value) instead of one — no per-row application loop, entirely inside
 * the database. */
export async function listAccessoryLedger(
  accessoryId: string,
  rawPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: AccessoryLedgerRow[]; pagination: Pagination }> {
  const [totalCountRow] = await db
    .select({ totalCount: count() })
    .from(accessoryMovements)
    .where(eq(accessoryMovements.accessoryId, accessoryId));
  const pagination = resolvePagination({ rawPage, totalCount: totalCountRow?.totalCount ?? 0, pageSize: PAGE_SIZE });

  const windowed = db
    .select({
      id: accessoryMovements.id,
      qty: accessoryMovements.qty,
      valueAmount: accessoryMovements.valueAmount,
      type: accessoryMovements.type,
      refType: accessoryMovements.refType,
      refId: accessoryMovements.refId,
      reason: accessoryMovements.reason,
      supplier: accessoryMovements.supplier,
      purchasedAt: accessoryMovements.purchasedAt,
      voidedAt: accessoryMovements.voidedAt,
      note: accessoryMovements.note,
      createdAt: accessoryMovements.createdAt,
      createdByStaffUserId: accessoryMovements.createdByStaffUserId,
      cumQtyFromNewest: sql<number>`(sum(${accessoryMovements.qty}) over (order by ${accessoryMovements.createdAt} desc, ${accessoryMovements.id} desc rows between unbounded preceding and current row))::int`.as(
        "cum_qty_from_newest",
      ),
      cumValueFromNewest: sql<string>`(sum(${accessoryMovements.valueAmount}) over (order by ${accessoryMovements.createdAt} desc, ${accessoryMovements.id} desc rows between unbounded preceding and current row))::bigint`.as(
        "cum_value_from_newest",
      ),
      totalQty: sql<number>`(sum(${accessoryMovements.qty}) over ())::int`.as("total_qty"),
      totalValue: sql<string>`(sum(${accessoryMovements.valueAmount}) over ())::bigint`.as("total_value"),
    })
    .from(accessoryMovements)
    .where(eq(accessoryMovements.accessoryId, accessoryId))
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
      runningQty: sql<number>`${windowed.totalQty} - ${windowed.cumQtyFromNewest} + ${windowed.qty}`,
      // bigint arithmetic -> comes back as a STRING (same reasoning as every other
      // value_amount-derived field in this file) — converted below.
      runningValueAmount: sql<string>`${windowed.totalValue} - ${windowed.cumValueFromNewest} + ${windowed.valueAmount}`,
    })
    .from(windowed)
    .leftJoin(staffUsers, eq(staffUsers.id, windowed.createdByStaffUserId))
    .orderBy(desc(windowed.createdAt), desc(windowed.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return {
    rows: rows.map((row) => ({ ...row, valueAmount: Number(row.valueAmount), runningValueAmount: Number(row.runningValueAmount) })),
    pagination,
  };
}

// ---------- Purchase ----------

export interface RecordAccessoryPurchaseInput {
  accessoryId: string;
  qty: number;
  totalAmountPaid: number;
  purchasedAt: string;
  supplier?: string | null;
  note?: string | null;
}

/** 1. Lock the accessory row FIRST — serializes against any concurrent purchase/consumption/
 * void on the SAME item, giving every movement a well-defined total order (which the
 * void-after-later-movement rule, correction #2, depends on being unambiguous).
 * 2. Insert one 'purchase' movement, `value_amount` = the EXACT amount paid (no rounding at
 * all — unlike a consumption, a purchase has nothing to compute, only to record). This is the
 * ONLY movement type that can ever move the average cost. */
export async function recordAccessoryPurchase(
  input: RecordAccessoryPurchaseInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  // A purchase's qty must be positive — this isn't just form validation: voidAccessoryPurchase's
  // own negative-stock guard is only unreachable (see that function's doc comment) BECAUSE every
  // purchase is guaranteed to add stock, never remove it. A negative-qty "purchase" would be a
  // disguised consumption that bypasses the void-after-later-movement rule entirely.
  if (input.qty <= 0) throw new FieldError("qty", "Jumlah harus lebih dari 0.");
  if (input.totalAmountPaid < 0) throw new FieldError("totalAmountPaid", "Total harga tidak boleh negatif.");

  return db.transaction(async (tx) => {
    const accessory = await lockAccessoryForUpdate(tx, input.accessoryId);
    if (!accessory) throw new ActionError("Aksesoris tidak ditemukan.");

    const [movement] = await tx
      .insert(accessoryMovements)
      .values({
        accessoryId: input.accessoryId,
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
    if (!movement) throw new Error("failed to insert accessory movement");

    await writeAuditLog(tx, { actorStaffUserId, action: "purchase", entityType: "accessory_movement", entityId: movement.id, after: movement });
    return movement;
  });
}

const BLOCKING_VOID_TYPES = ["production", "adjustment", "purchase_void"] as const;

/** Correction #2 (approved plan, binding): voids a 'purchase' movement by inserting an EXACT
 * reversal row (qty/value_amount negated, never recomputed at the current average — this is a
 * correction to a SPECIFIC prior entry, not a general consumption) — but only if no
 * consumption/adjustment/purchase_void movement for this SAME accessory was inserted AFTER it.
 * Voiding "through" a later movement would retroactively invalidate that movement's already-
 * recorded cost snapshot (see the worked example in the approved plan: buy 100@1000, buy
 * 100@2000, consume 100 valued at the 1500 average, THEN void the first purchase — the
 * consumption's already-recorded cost is now wrong, and simply reversing the first purchase's
 * own numbers doesn't fix it). Rejected with a message pointing at manual adjustment instead,
 * which IS allowed in that situation precisely because it's valued at whatever the average
 * already is NOW, not retroactively.
 *
 * `actorStaffUserId` is NON-nullable (unlike most other actor params here) because
 * accessory_movements_voided_pair_check requires voided_by_staff_user_id to be set together with
 * voided_at — same reasoning postBatch's own actorStaffUserId is non-nullable. */
export async function voidAccessoryPurchase(movementId: string, actorStaffUserId: string, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const [original] = await tx.select().from(accessoryMovements).where(eq(accessoryMovements.id, movementId)).limit(1);
    if (!original) throw new ActionError("Transaksi pembelian tidak ditemukan.");
    if (original.type !== "purchase") throw new ActionError("Hanya transaksi pembelian yang bisa dibatalkan.");

    // Lock the accessory row BEFORE re-checking voidedAt or the later-movement rule — serializes
    // against a concurrent void/purchase/consumption on the same item.
    const accessory = await lockAccessoryForUpdate(tx, original.accessoryId);
    if (!accessory) throw new Error("accessory not found for an existing movement");

    if (original.voidedAt !== null) throw new ActionError("Pembelian ini sudah dibatalkan sebelumnya.");

    const [laterBlocking] = await tx
      .select({ id: accessoryMovements.id })
      .from(accessoryMovements)
      .where(
        and(
          eq(accessoryMovements.accessoryId, original.accessoryId),
          inArray(accessoryMovements.type, BLOCKING_VOID_TYPES),
          // Deliberately drizzle's typed gt/eq/and/or operators, not a raw `sql` template or a
          // Postgres row-constructor ((a, b) > (c, d)) — both of those left postgres.js's
          // prepared-statement parameter-type inference ambiguous between a timestamp and a
          // uuid bind, which surfaced as a cross-call type mismatch once the same SQL text got
          // reused from its prepared-statement cache with a different "Date vs string" value.
          // These operators bind each parameter's type from its own column's schema instead.
          or(
            gt(accessoryMovements.createdAt, original.createdAt),
            and(eq(accessoryMovements.createdAt, original.createdAt), gt(accessoryMovements.id, original.id)),
          ),
        ),
      )
      .limit(1);
    if (laterBlocking) {
      throw new ActionError(
        'Pembelian ini tidak bisa dibatalkan karena sudah ada pergerakan stok sesudahnya. Gunakan "Sesuaikan stok" untuk mengoreksi jumlahnya.',
      );
    }

    // Defensive backstop, not the primary guarantee — given every 'purchase' row is enforced
    // positive (recordAccessoryPurchase) and the later-movement check above already rejects
    // voiding past ANY reducing (production/adjustment/purchase_void) movement, the running
    // balance at this point can never be less than `original.qty` in practice: nothing between
    // this purchase and now could have reduced it without ALSO being caught by that check
    // first. Kept anyway, same "advisory checks stay even when a different guarantee already
    // covers them" reasoning lib/products/fabric-queries.ts's deleteFabric gives for its own
    // pre-checks — cheap, and it fails loudly instead of silently if that invariant is ever
    // broken by a future change.
    const balance = await getAccessoryBalance(original.accessoryId, tx);
    if (balance.qty - original.qty < 0) {
      throw new ActionError("Pembatalan ini akan membuat stok menjadi negatif.");
    }

    const [voidMovement] = await tx
      .insert(accessoryMovements)
      .values({
        accessoryId: original.accessoryId,
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
      .update(accessoryMovements)
      .set({ voidedAt: new Date(), voidedByStaffUserId: actorStaffUserId })
      .where(eq(accessoryMovements.id, original.id))
      .returning();
    if (!updatedOriginal) throw new Error("failed to mark original movement as voided");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "void",
      entityType: "accessory_movement",
      entityId: original.id,
      before: original,
      after: { void: voidMovement, original: updatedOriginal },
    });
    return voidMovement;
  });
}

// ---------- Manual adjustment ----------

export interface RecordAccessoryAdjustmentInput {
  accessoryId: string;
  deltaQty: number;
  reason: StockAdjustmentReason;
  note?: string | null;
}

/** Same lock/check/insert shape as lib/stock/queries.ts's adjustStock. `value_amount` is valued
 * at the current average (via valueDeltaForConsumption) rather than recorded directly — an
 * adjustment has no amount-paid of its own, only a quantity correction, so it must be priced
 * against whatever the item's cost basis already is (and, per correction #1, exactly zeroed out
 * if this adjustment brings qty to 0). */
export async function recordAccessoryAdjustment(
  input: RecordAccessoryAdjustmentInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    const accessory = await lockAccessoryForUpdate(tx, input.accessoryId);
    if (!accessory) throw new ActionError("Aksesoris tidak ditemukan.");

    const balance = await getAccessoryBalance(input.accessoryId, tx);
    const newQty = balance.qty + input.deltaQty;
    if (newQty < 0) throw new FieldError("deltaQty", "Stok tidak boleh menjadi negatif.");

    const valueAmount = valueDeltaForConsumption(balance, input.deltaQty);

    const [movement] = await tx
      .insert(accessoryMovements)
      .values({
        accessoryId: input.accessoryId,
        qty: input.deltaQty,
        valueAmount,
        type: "adjustment",
        refType: "manual",
        reason: input.reason,
        note: input.note ?? null,
        createdByStaffUserId: actorStaffUserId,
      })
      .returning();
    if (!movement) throw new Error("failed to insert accessory movement");

    await writeAuditLog(tx, { actorStaffUserId, action: "adjust", entityType: "accessory_movement", entityId: movement.id, after: movement });
    return movement;
  });
}
