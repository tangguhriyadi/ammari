import "server-only";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import {
  accessories,
  accessoryMovements,
  costComponents,
  fabrics,
  fabricColors,
  fabricStockMovements,
  productionBatches,
  productionBatchAccessoryOverrides,
  productionBatchCosts,
  productionBatchItems,
  products,
  productVariants,
  staffUsers,
  stockMovements,
} from "@ammari/db/schema";
import type { CostComponentType, CostComponentUnit, ProductionBatchStatus } from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { ActionError, FieldError, isPostgresErrorCode, mapUniqueViolation } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { lockAccessoryForUpdate, lockFabricForUpdate } from "@/lib/inventory/db";
import { getAccessoryBalance } from "@/lib/inventory/accessories";
import { getFabricBalance } from "@/lib/inventory/fabric-stock";
import { valueDeltaForConsumption, type RawMaterialBalance } from "@/lib/inventory/moving-average";
import { lockProductionBatchForUpdate, type Tx } from "./db";
import { generateBatchNumber } from "./batch-number";
import { calculateUnitCost } from "./unit-cost";
import { resolveAccessoryNeeds } from "./accessory-needs";

// ---------- Eligible SKUs for a fabric ----------

export interface EligibleSkuRow {
  sku: string;
  size: string;
  productId: string;
  productName: string;
  productSizeMode: "sized" | "all_size";
  colorId: string;
  colorName: string;
  colorHex: string | null;
}

/** Active variants of any product using this fabric — the SKU picker's source list. Flat rows;
 * grouped product -> color -> size client-side (same division of labor as VariantBuilder's own
 * color groups). */
export async function listEligibleSkusForFabric(fabricId: string, db: Database = defaultDb): Promise<EligibleSkuRow[]> {
  return db
    .select({
      sku: productVariants.sku,
      size: productVariants.size,
      productId: products.id,
      productName: products.name,
      productSizeMode: products.sizeMode,
      colorId: fabricColors.id,
      colorName: fabricColors.name,
      colorHex: fabricColors.hex,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(and(eq(productVariants.fabricId, fabricId), eq(productVariants.isActive, true)))
    .orderBy(products.name, fabricColors.name, productVariants.size);
}

// ---------- List ----------

export interface ListBatchesRow {
  id: string;
  batchNo: string;
  producedAt: string;
  // `null` only for the one batch created before this column existed — the UI renders "—" for
  // it, never 0 (0 would falsely imply zero yards were actually used).
  fabricYards: number | null;
  status: ProductionBatchStatus;
  fabricName: string;
  totalPcs: number;
}

export async function listBatches(
  status: ProductionBatchStatus | undefined,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: ListBatchesRow[]; pagination: Pagination }> {
  const where = status ? eq(productionBatches.status, status) : undefined;

  const [totalCountRow] = await db.select({ totalCount: count() }).from(productionBatches).where(where);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });

  const rows = await db
    .select({
      id: productionBatches.id,
      batchNo: productionBatches.batchNo,
      producedAt: productionBatches.producedAt,
      fabricYards: productionBatches.fabricYards,
      status: productionBatches.status,
      fabricName: fabrics.name,
      totalPcs: sql<number>`coalesce(sum(${productionBatchItems.qty})::int, 0)`,
    })
    .from(productionBatches)
    .innerJoin(fabrics, eq(fabrics.id, productionBatches.fabricId))
    .leftJoin(productionBatchItems, eq(productionBatchItems.productionBatchId, productionBatches.id))
    .where(where)
    .groupBy(productionBatches.id, fabrics.name)
    .orderBy(desc(productionBatches.producedAt), desc(productionBatches.batchNo))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return { rows, pagination };
}

// ---------- Detail ----------

export interface BatchLineRow {
  id: string;
  sku: string;
  qty: number;
  // IS real cost data (the per-pcs HPP, computed at posting) — unlike every other field on this
  // row, this one is NOT safe to render outside a finance.view_profit-gated component. It is
  // only safe to SELECT here (not a leak in itself) because every current caller of
  // getBatchDetail either never renders it (ProductionBatchReadOnly ignores it entirely) or only
  // renders it already inside a `canViewProfit` branch (BatchCostsSection). Do not add a new
  // renderer of `lines` that prints this field without checking finance.view_profit first.
  unitCostAmount: number;
  size: string;
  colorName: string;
  colorHex: string | null;
  productName: string;
  productSizeMode: "sized" | "all_size";
  // The product's selling price — public information (shown on the catalog), not a cost figure,
  // so it's fine to include here for every caller regardless of finance.view_profit. Only the
  // Batas-HPP comparison that COMBINES this with cost data is gated (see BatchCostsSection).
  productBasePrice: number;
}

export interface BatchDetail {
  id: string;
  batchNo: string;
  fabricId: string;
  fabricName: string;
  producedAt: string;
  fabricYards: number | null;
  notes: string | null;
  status: ProductionBatchStatus;
  postedAt: Date | null;
  postedByName: string | null;
  lines: BatchLineRow[];
}

/** Deliberately selects ONLY non-cost columns from production_batches — fabric_cost_amount is
 * never part of this query's result at all, not merely hidden by the caller. fabric_yards is
 * NOT cost data (a physical quantity, not money) so every caller gets it regardless of
 * finance.view_profit — the "yard per pcs" hint needs it even for a production.manage-only
 * session. See getBatchCosts/getBatchExtraCosts for the separate, permission-gated queries. */
export async function getBatchDetail(id: string, db: Database = defaultDb): Promise<BatchDetail | null> {
  const [batch] = await db
    .select({
      id: productionBatches.id,
      batchNo: productionBatches.batchNo,
      fabricId: productionBatches.fabricId,
      fabricName: fabrics.name,
      producedAt: productionBatches.producedAt,
      fabricYards: productionBatches.fabricYards,
      notes: productionBatches.notes,
      status: productionBatches.status,
      postedAt: productionBatches.postedAt,
      postedByName: staffUsers.name,
    })
    .from(productionBatches)
    .innerJoin(fabrics, eq(fabrics.id, productionBatches.fabricId))
    .leftJoin(staffUsers, eq(staffUsers.id, productionBatches.postedByStaffUserId))
    .where(eq(productionBatches.id, id))
    .limit(1);
  if (!batch) return null;

  const lines = await db
    .select({
      id: productionBatchItems.id,
      sku: productionBatchItems.sku,
      qty: productionBatchItems.qty,
      unitCostAmount: productionBatchItems.unitCostAmount,
      size: productVariants.size,
      colorName: fabricColors.name,
      colorHex: fabricColors.hex,
      productName: products.name,
      productSizeMode: products.sizeMode,
      productBasePrice: products.basePrice,
    })
    .from(productionBatchItems)
    .innerJoin(productVariants, eq(productVariants.sku, productionBatchItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(productionBatchItems.productionBatchId, id))
    .orderBy(products.name, fabricColors.name, productVariants.size);

  return { ...batch, lines };
}

export interface BatchCosts {
  fabricCostAmount: number;
}

/** The ONLY query function that reads production_batches.fabric_cost_amount — callers must gate
 * this behind `session.permissionKeys.includes("finance.view_profit")` THEMSELVES (same contract
 * as getCurrentCostAssumption/ProductBatasHpp in lib/products): render the Server Component that
 * calls this conditionally, so the component (and this query) never runs at all for a session
 * without the permission, rather than running it and hiding the result. Only ever meaningful once
 * `status = 'posted'` — a draft's fabric_cost_amount is still its 0 column default (the fabric
 * cost is no longer settable at draft time at all; see fabric-cost-estimate.ts for the draft's
 * own live estimate instead). */
export async function getBatchCosts(id: string, db: Database = defaultDb): Promise<BatchCosts | null> {
  const [row] = await db
    .select({ fabricCostAmount: productionBatches.fabricCostAmount })
    .from(productionBatches)
    .where(eq(productionBatches.id, id))
    .limit(1);
  return row ?? null;
}

export interface ExtraCostLineRow {
  id: string;
  costComponentId: string;
  componentName: string;
  componentUnit: CostComponentUnit;
  costType: CostComponentType;
  quantity: number;
  unitPrice: number;
  total: number;
}

/** Same gating contract as getBatchCosts — itemized extra costs are cost data too. */
export async function getBatchExtraCosts(id: string, db: Database = defaultDb): Promise<ExtraCostLineRow[]> {
  return db
    .select({
      id: productionBatchCosts.id,
      costComponentId: productionBatchCosts.costComponentId,
      componentName: productionBatchCosts.componentName,
      componentUnit: productionBatchCosts.componentUnit,
      costType: productionBatchCosts.costType,
      quantity: productionBatchCosts.quantity,
      unitPrice: productionBatchCosts.unitPrice,
      total: productionBatchCosts.total,
    })
    .from(productionBatchCosts)
    .where(eq(productionBatchCosts.productionBatchId, id))
    .orderBy(productionBatchCosts.createdAt);
}

export interface BatchAccessoryConsumptionRow {
  accessoryId: string;
  accessoryName: string;
  /** Positive pcs consumed (the stored movement's own qty is negative — a consumption — this is
   * its absolute value, matching how the UI wants to display it). */
  qty: number;
  /** Positive cost of that consumption. Same gating contract as getBatchCosts — cost data. */
  valueAmount: number;
  /** Whether a production.manage session overrode this accessory's computed need before posting
   * (production_batch_accessory_overrides — the row is never deleted by posting, so it's still
   * readable afterward). A security-review finding on the override feature: a production.manage
   * session (which may lack finance.view_profit) can change a posted batch's recorded cost by
   * overriding how much of an accessory was "needed" — this flag lets a finance.view_profit
   * viewer at least SEE which lines were overridden, as a (lightweight, not a hard block) audit
   * signal, surfaced in BatchCostsSection. */
  overridden: boolean;
}

/** The posted batch's "Aksesoris" breakdown — one row per resolved accessory actually consumed
 * by this batch, read back from its own accessory_movements rows (ref_type='production_batch',
 * ref_id=this batch's id) rather than a separate summary table; the ledger IS the record. Same
 * gating contract as getBatchCosts/getBatchExtraCosts (cost data). Empty for a draft (no
 * consumption has happened yet) or a batch with no accessory recipe at all. */
export async function getBatchAccessoryConsumption(id: string, db: Database = defaultDb): Promise<BatchAccessoryConsumptionRow[]> {
  const rows = await db
    .select({
      accessoryId: accessoryMovements.accessoryId,
      accessoryName: accessories.name,
      qty: accessoryMovements.qty,
      valueAmount: accessoryMovements.valueAmount,
      overrideId: productionBatchAccessoryOverrides.id,
    })
    .from(accessoryMovements)
    .innerJoin(accessories, eq(accessories.id, accessoryMovements.accessoryId))
    .leftJoin(
      productionBatchAccessoryOverrides,
      and(
        eq(productionBatchAccessoryOverrides.productionBatchId, id),
        eq(productionBatchAccessoryOverrides.accessoryId, accessoryMovements.accessoryId),
      ),
    )
    .where(and(eq(accessoryMovements.refType, "production_batch"), eq(accessoryMovements.refId, id)))
    .orderBy(accessories.name);

  return rows.map((row) => ({
    accessoryId: row.accessoryId,
    accessoryName: row.accessoryName,
    qty: -row.qty,
    valueAmount: -row.valueAmount,
    overridden: row.overrideId !== null,
  }));
}

// ---------- Create / update / delete draft ----------

export interface BatchLineInput {
  sku: string;
  qty: number;
}

export interface ExtraCostLineInput {
  /** Omitted for a new line — present for an existing one, and MUST already belong to this
   * batch (see syncExtraCostLines, which rejects the whole save otherwise). */
  id?: string;
  costComponentId: string;
  /** No `quantity` field — NEVER submitted by the client for either cost_type. A 'variable'
   * line's quantity is always this batch's current total pcs, computed server-side on every
   * save (see syncExtraCostLines) and re-verified again at posting; a 'fixed' line's quantity is
   * always exactly 1 (its unit_price IS the flat per-batch amount). */
  unitPrice: number;
}

export interface CreateDraftInput {
  fabricId: string;
  producedAt: string;
  fabricYards: number | null;
  notes?: string | null;
  lines: BatchLineInput[];
  /** `undefined` when the caller's session lacks finance.view_profit — see
   * ExtraCostLineInput/syncExtraCostLines' own doc comments for the `undefined`-means-"don't
   * touch" contract (not `?? []`, which would silently delete an existing owner-entered list on
   * an update by a session that can't see costs at all). Fabric cost itself is never part of
   * this input anymore — it's computed only at posting (see postBatch/fabric-cost-estimate.ts). */
  extraCosts?: ExtraCostLineInput[];
}

async function insertLines(tx: Tx, productionBatchId: string, fabricId: string, lines: readonly BatchLineInput[]): Promise<void> {
  if (lines.length === 0) return;
  try {
    await tx.insert(productionBatchItems).values(
      lines.map((line) => ({
        productionBatchId,
        fabricId,
        sku: line.sku,
        qty: line.qty,
      })),
    );
  } catch (error) {
    // The composite FK (sku, fabric_id) -> product_variants(sku, fabric_id) is the real
    // guarantee that every line's SKU belongs to THIS batch's fabric — this just turns a raw
    // 23503 into a friendly, field-scoped message instead.
    if (isPostgresErrorCode(error, "23503")) {
      throw new FieldError("sku", "SKU ini bukan milik produk berbahan ini.");
    }
    // The action's own Zod schema already rejects a duplicate SKU within one submission (see
    // draftFieldsSchema), but this is also directly callable — mapUniqueViolation turns the DB's
    // own backstop (production_batch_items_batch_sku_key) into the same friendly message rather
    // than an opaque 23505 reaching the caller; rethrows anything else unrecognized.
    mapUniqueViolation(error, {
      production_batch_items_batch_sku_key: {
        field: "sku",
        message: "Satu SKU tidak boleh muncul dua kali dalam satu batch.",
      },
    });
  }
}

/** Diffs `lines` against whatever already exists for this batch — NOT a delete-all-reinsert
 * (unlike insertLines above): component_name/component_unit/cost_type must stay frozen at
 * whatever they were when a line was ORIGINALLY added, surviving later, unrelated edits to the
 * same draft (e.g. changing a different line's quantity must never re-snapshot this one). So:
 *  - a submitted line WITH an id updates ONLY unit_price (and recomputes quantity — see below);
 *    the component/name/unit/cost_type snapshot is never re-picked;
 *  - a submitted line with NO id is a fresh INSERT, snapshotting the component's CURRENT
 *    name/unit/cost_type, and must reference an ACTIVE component;
 *  - an existing row whose id is missing from the submitted set is DELETED.
 * Every id the client submits is checked against this batch's OWN rows FIRST — a mismatched id
 * (nonexistent, or belonging to a different batch entirely) rejects the WHOLE save rather than
 * silently no-op'ing on a scoped WHERE, since that could otherwise mask a real client bug.
 *
 * `quantity` is NEVER taken from the client for either existing or new lines (see
 * ExtraCostLineInput's own doc comment) — `totalPcs` (this batch's current `sum(qty)` across the
 * lines being saved in THIS SAME call) decides it: a 'variable' line's quantity is always
 * `totalPcs`, recomputed on every single save regardless of whether totalPcs actually changed, so
 * it can never silently drift; a 'fixed' line's quantity is always exactly 1. A 'variable' line
 * can't be saved while totalPcs is 0 (quantity > 0 is a DB CHECK) — rejected with a friendly
 * message rather than a raw constraint error. */
async function syncExtraCostLines(
  tx: Tx,
  productionBatchId: string,
  lines: readonly ExtraCostLineInput[],
  totalPcs: number,
): Promise<void> {
  const existing = await tx
    .select()
    .from(productionBatchCosts)
    .where(eq(productionBatchCosts.productionBatchId, productionBatchId));
  const existingById = new Map(existing.map((row) => [row.id, row]));

  for (const line of lines) {
    if (line.id && !existingById.has(line.id)) {
      throw new ActionError("Salah satu baris biaya tidak ditemukan di batch ini.");
    }
  }

  const submittedIds = new Set(lines.filter((line) => line.id).map((line) => line.id!));
  const toDeleteIds = existing.filter((row) => !submittedIds.has(row.id)).map((row) => row.id);
  if (toDeleteIds.length > 0) {
    await tx
      .delete(productionBatchCosts)
      .where(and(inArray(productionBatchCosts.id, toDeleteIds), eq(productionBatchCosts.productionBatchId, productionBatchId)));
  }

  for (const line of lines) {
    if (!line.id) continue;
    const existingRow = existingById.get(line.id)!;
    if (existingRow.costType === "variable" && totalPcs <= 0) {
      throw new FieldError(
        "costComponentId",
        `Tambahkan minimal satu baris produksi (SKU) sebelum menyimpan biaya variabel "${existingRow.componentName}".`,
      );
    }
    const quantity = existingRow.costType === "variable" ? totalPcs : 1;
    await tx
      .update(productionBatchCosts)
      .set({ quantity, unitPrice: line.unitPrice })
      .where(and(eq(productionBatchCosts.id, line.id), eq(productionBatchCosts.productionBatchId, productionBatchId)));
  }

  const newLines = lines.filter((line) => !line.id);
  if (newLines.length === 0) return;

  const componentIds = [...new Set(newLines.map((line) => line.costComponentId))];
  const components = await tx.select().from(costComponents).where(inArray(costComponents.id, componentIds));
  const componentById = new Map(components.map((component) => [component.id, component]));

  const values = newLines.map((line) => {
    const component = componentById.get(line.costComponentId);
    if (!component) throw new FieldError("costComponentId", "Komponen biaya tidak ditemukan.");
    // Only a NEW line requires an active component — an EXISTING line (handled in the update
    // loop above) never re-checks this, so a component deactivated after the line was added
    // keeps working, exactly as required.
    // KNOWN GAP (low impact, not fixed): this is read-then-write, not atomic — nothing stops a
    // concurrent setCostComponentActive(componentId, false) from committing between the SELECT
    // above and this INSERT, so a brand-new line could end up referencing a component that's
    // inactive by the time this transaction commits. The batch row lock only serializes against
    // another write to THIS batch, not against a write to cost_components. Soft validation rule,
    // not a financial double-count — accepted rather than adding FOR SHARE/a stricter check.
    if (!component.isActive) {
      throw new FieldError("costComponentId", `Komponen "${component.name}" sudah dinonaktifkan dan tidak bisa dipakai untuk baris baru.`);
    }
    if (component.costType === "variable" && totalPcs <= 0) {
      throw new FieldError(
        "costComponentId",
        `Tambahkan minimal satu baris produksi (SKU) sebelum menambah biaya variabel "${component.name}".`,
      );
    }
    return {
      productionBatchId,
      costComponentId: component.id,
      componentName: component.name,
      componentUnit: component.unit,
      costType: component.costType,
      quantity: component.costType === "variable" ? totalPcs : 1,
      unitPrice: line.unitPrice,
    };
  });
  await tx.insert(productionBatchCosts).values(values);
}

export async function createDraft(input: CreateDraftInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const batchNo = await generateBatchNumber(tx);
    const [batch] = await tx
      .insert(productionBatches)
      .values({
        fabricId: input.fabricId,
        batchNo,
        producedAt: input.producedAt,
        fabricYards: input.fabricYards,
        notes: input.notes ?? null,
      })
      .returning();
    if (!batch) throw new Error("failed to insert production batch");

    await insertLines(tx, batch.id, input.fabricId, input.lines);
    if (input.extraCosts !== undefined) {
      const totalPcs = input.lines.reduce((sum, line) => sum + line.qty, 0);
      await syncExtraCostLines(tx, batch.id, input.extraCosts, totalPcs);
    }

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "create",
      entityType: "production_batch",
      entityId: batch.id,
      after: { ...batch, lines: input.lines },
    });
    return batch;
  });
}

export interface UpdateDraftInput {
  producedAt: string;
  fabricYards: number | null;
  notes?: string | null;
  lines: BatchLineInput[];
  /** Same `undefined`-means-"don't touch" contract as CreateDraftInput.extraCosts — when
   * omitted, syncExtraCostLines isn't even called, so an existing owner-entered list is never
   * read or written. */
  extraCosts?: ExtraCostLineInput[];
}

/** The row lock (step 1) MUST happen before touching productionBatchItems OR
 * productionBatchCosts — a concurrent postBatch locks the SAME row first and blocks until this
 * whole transaction commits or rolls back, so there is no window where postBatch can compute
 * HPP from a partially-synced set of lines. (The posted-batch triggers are a second, independent
 * backstop — see migration 0007 — but the row lock is what actually prevents the race itself,
 * same reasoning lockProductForUpdate's own doc comment gives for the products feature.) */
export async function updateDraft(id: string, input: UpdateDraftInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const before = await lockProductionBatchForUpdate(tx, id);
    if (!before) throw new ActionError("Batch tidak ditemukan.");
    if (before.status !== "draft") throw new ActionError("Batch yang sudah diposting tidak bisa diubah.");

    const [after] = await tx
      .update(productionBatches)
      .set({
        producedAt: input.producedAt,
        fabricYards: input.fabricYards,
        notes: input.notes ?? null,
      })
      .where(eq(productionBatches.id, id))
      .returning();
    if (!after) throw new Error("failed to update production batch");

    // Full replace, not a diff — a draft's lines have no history worth preserving row-by-row
    // (unlike the extra-cost lines' frozen snapshots), so the simplest correct model is "the
    // lines the form submitted are now the whole set".
    await tx.delete(productionBatchItems).where(eq(productionBatchItems.productionBatchId, id));
    await insertLines(tx, id, before.fabricId, input.lines);

    if (input.extraCosts !== undefined) {
      const totalPcs = input.lines.reduce((sum, line) => sum + line.qty, 0);
      await syncExtraCostLines(tx, id, input.extraCosts, totalPcs);
    }

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "update",
      entityType: "production_batch",
      entityId: id,
      before,
      after: { ...after, lines: input.lines },
    });
    return after;
  });
}

export async function deleteDraft(id: string, actorStaffUserId: string | null, db: Database = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await lockProductionBatchForUpdate(tx, id);
    if (!before) throw new ActionError("Batch tidak ditemukan.");
    if (before.status !== "draft") throw new ActionError("Batch yang sudah diposting tidak bisa dihapus.");

    await tx.delete(productionBatches).where(eq(productionBatches.id, id));
    await writeAuditLog(tx, { actorStaffUserId, action: "delete", entityType: "production_batch", entityId: id, before });
  });
}

// ---------- Post ----------

export interface PostedBatchResult {
  id: string;
  unitCostAmount: number;
  totalPcs: number;
}

/** Steps (ALL inside one transaction):
 * 1. `SELECT ... FOR UPDATE` the batch row FIRST — serializes a concurrent second post attempt;
 *    it blocks until this transaction commits, then sees status='posted' and fails cleanly
 *    instead of double-posting. Also serializes against a concurrent updateDraft the same way.
 * 2. Must be a draft, with at least one line and fabric_yards > 0.
 * 3. Resolve the accessory recipe for every line (resolveAccessoryNeeds) — any unresolved
 *    size-group row rejects immediately with a message naming every product/size/group (a
 *    configuration problem, not a stock race).
 * 4. Lock the fabric row (always exactly one), then every NEEDED accessory row in sorted id
 *    order — deterministic, avoids a deadlock against a concurrent post/purchase/adjustment on
 *    the same items (same reasoning saveStockCount sorts SKUs before locking).
 * 5. Collect EVERY shortage (fabric included) before writing anything — rejects listing every
 *    short item in ONE message, not fail-fast on the first.
 * 6. Re-verify every variable-cost line's quantity against the batch's ACTUAL total pcs (never
 *    trusts whatever a prior draft save computed, or a client-submitted value — there is none).
 * 7. Value the fabric and every accessory's consumption at their CURRENT moving-average cost
 *    (valueDeltaForConsumption — the same zero-residual rule accessories/fabric adjustments
 *    already use applies for free), write one fabric_stock_movements row and one
 *    accessory_movements row per resolved accessory (ref_type='production_batch').
 * 8. totalCost = fabricCost + Σ(accessory consumption costs) + Σ(production_batch_costs.total,
 *    variable AND fixed). unitCost = ceil(totalCost / totalPcs), written to every line.
 * 9. One stock_movements row per line (type='production', ref_type='production_batch_item').
 * 10. status='posted', posted_at, posted_by_staff_user_id, fabric_cost_amount (computed, not
 *     user-entered — see fabric-cost-estimate.ts for the draft's own non-binding estimate).
 * 11. One audit_log entry for the whole post. */
export async function postBatch(id: string, actorStaffUserId: string, db: Database = defaultDb): Promise<PostedBatchResult> {
  return db.transaction(async (tx) => {
    const before = await lockProductionBatchForUpdate(tx, id);
    if (!before) throw new ActionError("Batch tidak ditemukan.");
    if (before.status !== "draft") throw new ActionError("Batch ini sudah diposting.");

    const lines = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, id));
    if (lines.length === 0) throw new ActionError("Tambahkan minimal satu baris produksi sebelum posting.");
    if (before.fabricYards === null || before.fabricYards <= 0) {
      throw new ActionError("Isi jumlah yard bahan sebelum posting.");
    }
    const fabricYards = before.fabricYards;
    const totalPcs = lines.reduce((sum, line) => sum + line.qty, 0);

    const { neededByAccessoryId, unresolved } = await resolveAccessoryNeeds(
      lines.map((line) => ({ sku: line.sku, qty: line.qty })),
      tx,
    );
    if (unresolved.length > 0) {
      const names = unresolved
        .map((row) => `${row.productName} (ukuran ${row.size === "ALLSIZE" ? "All Size" : row.size}, grup "${row.sizeGroup}")`)
        .join("; ");
      throw new ActionError(`Resep aksesoris belum lengkap untuk: ${names}.`);
    }

    const fabric = await lockFabricForUpdate(tx, before.fabricId);
    if (!fabric) throw new Error("fabric not found for an existing production batch");
    const fabricBalanceBefore = await getFabricBalance(before.fabricId, tx);

    const accessoryIds = [...neededByAccessoryId.keys()].sort();
    const overrideRows =
      accessoryIds.length > 0
        ? await tx
            .select()
            .from(productionBatchAccessoryOverrides)
            .where(
              and(
                eq(productionBatchAccessoryOverrides.productionBatchId, id),
                inArray(productionBatchAccessoryOverrides.accessoryId, accessoryIds),
              ),
            )
        : [];
    const overrideByAccessoryId = new Map(overrideRows.map((row) => [row.accessoryId, row.overrideQty]));

    const accessoryBalanceBefore = new Map<string, RawMaterialBalance>();
    for (const accessoryId of accessoryIds) {
      const accessory = await lockAccessoryForUpdate(tx, accessoryId);
      if (!accessory) throw new Error("accessory not found for a resolved recipe need");
      accessoryBalanceBefore.set(accessoryId, await getAccessoryBalance(accessoryId, tx));
    }
    const accessoryRows = accessoryIds.length > 0 ? await tx.select().from(accessories).where(inArray(accessories.id, accessoryIds)) : [];
    const accessoryById = new Map(accessoryRows.map((row) => [row.id, row]));

    const effectiveNeedByAccessoryId = new Map<string, number>();
    const shortages: string[] = [];
    if (fabricYards > fabricBalanceBefore.qty) {
      shortages.push(`${fabric.name}: butuh ${fabricYards} yard, stok ${fabricBalanceBefore.qty} yard`);
    }
    for (const accessoryId of accessoryIds) {
      const computedQty = neededByAccessoryId.get(accessoryId)!;
      const effectiveQty = overrideByAccessoryId.get(accessoryId) ?? computedQty;
      effectiveNeedByAccessoryId.set(accessoryId, effectiveQty);
      const balance = accessoryBalanceBefore.get(accessoryId)!;
      if (effectiveQty > balance.qty) {
        shortages.push(`${accessoryById.get(accessoryId)?.name ?? accessoryId}: butuh ${effectiveQty} pcs, stok ${balance.qty} pcs`);
      }
    }
    if (shortages.length > 0) {
      throw new ActionError(`Stok tidak cukup untuk posting: ${shortages.join("; ")}.`);
    }

    // Re-verify (never trust) every variable line's quantity — see this function's own doc
    // comment, step 6.
    await tx
      .update(productionBatchCosts)
      .set({ quantity: totalPcs })
      .where(and(eq(productionBatchCosts.productionBatchId, id), eq(productionBatchCosts.costType, "variable")));

    const fabricConsumptionValue = valueDeltaForConsumption(fabricBalanceBefore, -fabricYards);
    await tx.insert(fabricStockMovements).values({
      fabricId: before.fabricId,
      qty: -fabricYards,
      valueAmount: fabricConsumptionValue,
      type: "production",
      refType: "production_batch",
      refId: id,
      createdByStaffUserId: actorStaffUserId,
    });
    const fabricCostAmount = -fabricConsumptionValue;

    let accessoryCostTotal = 0;
    // An override of exactly 0 means "none of this needed after all" — skipped entirely rather
    // than inserting a qty=0 movement, which the DB's own `qty <> 0` CHECK would reject anyway.
    const accessoryIdsToConsume = accessoryIds.filter((accessoryId) => (effectiveNeedByAccessoryId.get(accessoryId) ?? 0) > 0);
    if (accessoryIdsToConsume.length > 0) {
      const accessoryMovementValues = accessoryIdsToConsume.map((accessoryId) => {
        const effectiveQty = effectiveNeedByAccessoryId.get(accessoryId)!;
        const balance = accessoryBalanceBefore.get(accessoryId)!;
        const consumptionValue = valueDeltaForConsumption(balance, -effectiveQty);
        accessoryCostTotal += -consumptionValue;
        return {
          accessoryId,
          qty: -effectiveQty,
          valueAmount: consumptionValue,
          type: "production" as const,
          refType: "production_batch" as const,
          refId: id,
          createdByStaffUserId: actorStaffUserId,
        };
      });
      await tx.insert(accessoryMovements).values(accessoryMovementValues);
    }

    const extraCostRows = await tx
      .select({ total: productionBatchCosts.total })
      .from(productionBatchCosts)
      .where(eq(productionBatchCosts.productionBatchId, id));
    const extraCostsTotal = extraCostRows.reduce((sum, row) => sum + row.total, 0);

    const totalCost = fabricCostAmount + accessoryCostTotal + extraCostsTotal;
    const unitCostAmount = calculateUnitCost(totalCost, totalPcs);

    await tx.update(productionBatchItems).set({ unitCostAmount }).where(eq(productionBatchItems.productionBatchId, id));

    // One movement per line, in a single INSERT — the partial unique index on
    // (type, ref_type, ref_id) is a defense-in-depth backstop; the row lock above is what
    // actually prevents a concurrent double-post from reaching this statement twice.
    // valueAmount = qty * this line's own unitCostAmount — a 'production' movement is an inflow
    // with its own known cost (the batch's costing, just computed above), the same role a
    // raw-material 'purchase' plays for accessory_movements/fabric_stock_movements: it's the ONLY
    // finished-goods movement type that moves a SKU's moving average with a fresh cost basis
    // (see stock_movements.valueAmount's doc comment in catalog.ts).
    await tx.insert(stockMovements).values(
      lines.map((line) => ({
        sku: line.sku,
        qty: line.qty,
        valueAmount: line.qty * unitCostAmount,
        type: "production" as const,
        refType: "production_batch_item" as const,
        refId: line.id,
        createdByStaffUserId: actorStaffUserId,
      })),
    );

    const [after] = await tx
      .update(productionBatches)
      .set({ status: "posted", postedAt: new Date(), postedByStaffUserId: actorStaffUserId, fabricCostAmount })
      .where(eq(productionBatches.id, id))
      .returning();
    if (!after) throw new Error("failed to update production batch");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "post",
      entityType: "production_batch",
      entityId: id,
      before,
      after: { ...after, unitCostAmount, totalPcs, accessoryCostTotal, extraCostsTotal },
    });

    return { id, unitCostAmount, totalPcs };
  });
}
