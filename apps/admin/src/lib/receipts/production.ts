import "server-only";
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  fabricColors,
  goodsReceiptItems,
  goodsReceipts,
  productionBatches,
  productionBatchItems,
  products,
  productVariants,
  staffUsers,
  stockMovements,
  type GoodsReceiptKind,
  type ProductionReceiptStatus,
} from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { nextDocumentNumber } from "@/lib/documents/document-number";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { lockProductionBatchForUpdate } from "@/lib/production/db";
import { batchReceiptProgressStatus, batchStatusAfterReceiptChange, isOpenBatchReceiptStatus, type BatchLineProgress } from "@/lib/production/receipt-status";
import { lockVariantForUpdate } from "@/lib/stock/db";
import { currentBalanceForSkuLocked } from "@/lib/stock/queries";
import { assertReceivedAt } from "./received-at";

// Goods receipts of production output (docs/plans/suppliers-goods-receipt.md §5, session S4).
// Posting a batch consumes material and freezes HPP but no longer adds finished-goods stock (D4);
// a receipt here is the ONLY way a batch's output enters sellable stock (D3). This session records
// accepted pcs only; rejects/defect stock arrive in S5.
//
// Legacy batches: releases before S4 wrote one 'production' stock_movements row per line AT
// POSTING (ref_type 'production_batch_item'). Those rows count as received for their line, so a
// legacy batch is always fully received here, never offered a receipt, and never double counted —
// including one posted by the previous release after migration 0025 ran (which the migration's
// receipt_status backfill can't have seen).

export interface BatchReceiptLineInput {
  productionBatchItemId: string;
  qtyAccepted: number;
}

export interface PostBatchReceiptInput {
  batchId: string;
  receivedAt: string;
  receivedByName?: string | null;
  note?: string | null;
  lines: BatchReceiptLineInput[];
}

/** Net received pcs per batch line, for every line of the given batches: receipt items (receipts
 * minus reversals) plus legacy at-posting stock rows. Always SUMs, never a stored counter — two
 * grouped queries whatever the number of batches. Safe to call unlocked for display; a write that
 * decides on it must have locked the batch row first. */
export async function getReceivedByLineForBatches(batchIds: readonly string[], db: Database = defaultDb): Promise<Map<string, number>> {
  if (batchIds.length === 0) return new Map();
  const lineIds = (
    await db.select({ id: productionBatchItems.id }).from(productionBatchItems).where(inArray(productionBatchItems.productionBatchId, [...batchIds]))
  ).map((row) => row.id);
  if (lineIds.length === 0) return new Map();

  const [receiptRows, legacyRows] = await Promise.all([
    db
      .select({ lineId: goodsReceiptItems.productionBatchItemId, qty: sql<string>`sum(${goodsReceiptItems.qtyAccepted})` })
      .from(goodsReceiptItems)
      .where(inArray(goodsReceiptItems.productionBatchItemId, lineIds))
      .groupBy(goodsReceiptItems.productionBatchItemId),
    // ref_id is text: compare against the ids as text (backed by stock_movements_ref_idx), never
    // cast the column.
    db
      .select({ lineId: stockMovements.refId, qty: sql<string>`sum(${stockMovements.qty})` })
      .from(stockMovements)
      .where(and(eq(stockMovements.type, "production"), eq(stockMovements.refType, "production_batch_item"), inArray(stockMovements.refId, lineIds)))
      .groupBy(stockMovements.refId),
  ]);

  const received = new Map<string, number>(lineIds.map((id) => [id, 0]));
  for (const row of [...receiptRows, ...legacyRows]) {
    if (row.lineId) received.set(row.lineId, (received.get(row.lineId) ?? 0) + Number(row.qty));
  }
  return received;
}

/** {@link getReceivedByLineForBatches} for one batch. */
export async function getBatchReceivedByLine(batchId: string, db: Database = defaultDb): Promise<Map<string, number>> {
  return getReceivedByLineForBatches([batchId], db);
}

/** The EFFECTIVE receipt status of each batch (see BatchReceiptSummary.receiptStatus): the stored
 * one, except that an open stored status on a posted batch is re-derived from its lines. Batched
 * (a fixed number of queries), for list pages. */
export async function effectiveReceiptStatuses(
  batches: readonly { id: string; status: string; receiptStatus: ProductionReceiptStatus }[],
  db: Database = defaultDb,
): Promise<Map<string, ProductionReceiptStatus>> {
  const result = new Map(batches.map((batch) => [batch.id, batch.receiptStatus]));
  const openIds = batches.filter((batch) => batch.status === "posted" && isOpenBatchReceiptStatus(batch.receiptStatus)).map((batch) => batch.id);
  if (openIds.length === 0) return result;
  const [lines, received] = await Promise.all([
    db
      .select({ id: productionBatchItems.id, batchId: productionBatchItems.productionBatchId, qty: productionBatchItems.qty })
      .from(productionBatchItems)
      .where(inArray(productionBatchItems.productionBatchId, openIds)),
    getReceivedByLineForBatches(openIds, db),
  ]);
  const progressByBatch = new Map<string, BatchLineProgress[]>();
  for (const line of lines) {
    const list = progressByBatch.get(line.batchId) ?? [];
    list.push({ planned: line.qty, received: received.get(line.id) ?? 0 });
    progressByBatch.set(line.batchId, list);
  }
  for (const id of openIds) result.set(id, batchReceiptProgressStatus(progressByBatch.get(id) ?? []));
  return result;
}

async function getBatchLineProgress(batchId: string, db: Database): Promise<BatchLineProgress[]> {
  const [lines, received] = await Promise.all([
    db.select({ id: productionBatchItems.id, qty: productionBatchItems.qty }).from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, batchId)),
    getBatchReceivedByLine(batchId, db),
  ]);
  return lines.map((line) => ({ planned: line.qty, received: received.get(line.id) ?? 0 }));
}

function sizeLabel(size: string): string {
  return size === "ALLSIZE" ? "All Size" : size;
}

/** "Gamis Laila · Hitam · M" — the name a line is shown and referred to by in messages. */
function lineLabel(row: { productName: string; colorName: string; size: string }): string {
  return `${row.productName} · ${row.colorName} · ${sizeLabel(row.size)}`;
}

function batchLinesQuery(db: Database, batchId: string) {
  return db
    .select({
      id: productionBatchItems.id,
      sku: productionBatchItems.sku,
      qty: productionBatchItems.qty,
      unitCostAmount: productionBatchItems.unitCostAmount,
      productId: products.id,
      productName: products.name,
      colorName: fabricColors.name,
      size: productVariants.size,
    })
    .from(productionBatchItems)
    .innerJoin(productVariants, eq(productVariants.sku, productionBatchItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(productionBatchItems.productionBatchId, batchId));
}

/** Lock the variant rows in §5's shared order (SKUs sorted) — the batch row must already be locked
 * (it always comes first), the same order saveStockCount establishes. */
async function lockVariantsInOrder(tx: Tx, skus: readonly string[]): Promise<void> {
  for (const sku of [...new Set(skus)].sort()) {
    if (!(await lockVariantForUpdate(tx, sku))) throw new Error(`variant ${sku} not found for a batch line`);
  }
}

/** §5 `postGoodsReceiptForBatch`, one transaction — the same shape as the purchase receipt:
 * 1. lock the production_batches row FIRST (two phones receiving the same batch serialize; the
 *    second re-reads and either posts the remainder or fails cleanly);
 * 2. require status 'posted' and receipt_status pending / partially received;
 * 3. recompute received/outstanding per line INSIDE the lock and reject over-receipt (D17) with a
 *    message naming the line and what is left, and reject a receipt where every line is zero;
 * 4. lock the variant rows in sorted SKU order;
 * 5. insert the receipt header and its items;
 * 6. per line, one 'production' stock_movements row (ref_type 'goods_receipt_item', ref_id = the
 *    receipt item, value = qty × the line's frozen unit_cost_amount — HPP is never recomputed);
 * 7. recompute and store receipt_status (never `status`, D5);
 * 8. one audit entry for the whole receipt. */
export async function postGoodsReceiptForBatch(input: PostBatchReceiptInput, actorStaffUserId: string, db: Database = defaultDb) {
  assertReceivedAt(input.receivedAt);
  const requested = input.lines.filter((line) => line.qtyAccepted !== 0);
  if (requested.length === 0) throw new FieldError("lines", "Isi jumlah diterima minimal untuk satu SKU.");
  const seen = new Set<string>();
  for (const line of requested) {
    if (!Number.isSafeInteger(line.qtyAccepted) || line.qtyAccepted < 0) throw new FieldError("lines", "Jumlah diterima harus bilangan bulat.");
    if (seen.has(line.productionBatchItemId)) throw new FieldError("lines", "Satu SKU hanya boleh muncul sekali dalam satu penerimaan.");
    seen.add(line.productionBatchItemId);
  }

  return db.transaction(async (tx) => {
    const batch = await lockProductionBatchForUpdate(tx, input.batchId);
    if (!batch) throw new ActionError("Batch tidak ditemukan.");
    if (batch.status !== "posted") throw new ActionError("Batch ini belum diposting, belum ada hasil yang bisa diterima.");
    if (!isOpenBatchReceiptStatus(batch.receiptStatus)) {
      throw new ActionError(
        batch.receiptStatus === "received"
          ? "Semua hasil batch ini sudah diterima."
          : "Batch ini sudah ditutup, tidak bisa menerima hasil lagi.",
      );
    }

    const lineRows = await batchLinesQuery(tx, batch.id);
    const linesById = new Map(lineRows.map((row) => [row.id, row]));
    const receivedBefore = await getBatchReceivedByLine(batch.id, tx);

    const planned = requested.map((request) => {
      const line = linesById.get(request.productionBatchItemId);
      if (!line) throw new FieldError("lines", "SKU ini bukan bagian dari batch.");
      const outstanding = line.qty - (receivedBefore.get(line.id) ?? 0);
      if (request.qtyAccepted > outstanding) {
        throw new FieldError(
          "lines",
          outstanding <= 0
            ? `${lineLabel(line)} sudah diterima lengkap, tidak bisa menerima lagi.`
            : `Jumlah diterima untuk ${lineLabel(line)} melebihi sisa batch. Sisa yang belum diterima: ${outstanding} pcs.`,
        );
      }
      return { line, qty: request.qtyAccepted };
    });

    await lockVariantsInOrder(tx, planned.map((plan) => plan.line.sku));

    const receiptNo = await nextDocumentNumber(tx, "GR", goodsReceipts.receiptNo);
    const [receipt] = await tx
      .insert(goodsReceipts)
      .values({
        receiptNo,
        sourceType: "production_batch",
        productionBatchId: batch.id,
        kind: "receipt",
        receivedAt: input.receivedAt,
        receivedByName: input.receivedByName?.trim() || null,
        note: input.note?.trim() || null,
        createdByStaffUserId: actorStaffUserId,
      })
      .returning();
    if (!receipt) throw new Error("failed to insert goods receipt");

    const items = await tx
      .insert(goodsReceiptItems)
      .values(
        planned.map((plan) => ({
          goodsReceiptId: receipt.id,
          sourceType: "production_batch" as const,
          kind: "receipt" as const,
          productionBatchItemId: plan.line.id,
          qtyAccepted: plan.qty,
        })),
      )
      .returning();
    const itemByLine = new Map(items.map((item) => [item.productionBatchItemId!, item]));

    const movements = await tx
      .insert(stockMovements)
      .values(
        planned.map((plan) => ({
          sku: plan.line.sku,
          qty: plan.qty,
          valueAmount: plan.qty * plan.line.unitCostAmount,
          type: "production" as const,
          refType: "goods_receipt_item" as const,
          refId: itemByLine.get(plan.line.id)!.id,
          note: `${batch.batchNo} · ${receiptNo}`,
          createdByStaffUserId: actorStaffUserId,
        })),
      )
      .returning();

    const receiptStatus = batchStatusAfterReceiptChange(batch.receiptStatus, await getBatchLineProgress(batch.id, tx));
    if (receiptStatus !== batch.receiptStatus) {
      await tx.update(productionBatches).set({ receiptStatus }).where(eq(productionBatches.id, batch.id));
    }

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "receive",
      entityType: "goods_receipt",
      entityId: receipt.id,
      after: { receipt, items, movements, batchReceiptStatus: { before: batch.receiptStatus, after: receiptStatus } },
    });
    return { receipt, status: receiptStatus };
  });
}

/** Finished-goods movement types that consume or correct a SKU's units. A receipt cannot be
 * reversed once any of these was recorded for the same SKU after it: the units may have been sold
 * (an order — packed or not — always has its 'sale' row) or counted/adjusted, and stock is pooled
 * per SKU, so there is no telling which units those were. Same conservative rule the raw-material
 * void already applies. */
const BLOCKING_FINISHED_GOODS_TYPES = ["sale", "adjustment"] as const;

async function hasLaterBlockingStockMovement(tx: Tx, original: { id: string; sku: string; createdAt: Date }): Promise<boolean> {
  const [row] = await tx
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.sku, original.sku),
        inArray(stockMovements.type, BLOCKING_FINISHED_GOODS_TYPES),
        or(gt(stockMovements.createdAt, original.createdAt), and(eq(stockMovements.createdAt, original.createdAt), gt(stockMovements.id, original.id))),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** §5 `reverseGoodsReceipt` for a production receipt. Runs inside the caller's transaction
 * (reverseGoodsReceipt in ./queries.ts dispatches here):
 * 1. lock the batch row, then the receipt row, then the variant rows in sorted SKU order;
 * 2. reject if the receipt is already reversed or is itself a reversal;
 * 3. reject if any of its SKUs was sold or adjusted after the receipt (pointing at "Sesuaikan
 *    stok"), and — as a backstop — if reversing would take a SKU's balance negative;
 * 4. insert a kind='reversal' receipt whose items are the exact negation, one exactly negated
 *    'production' stock row per original row (stock_movements is append-only: a new row, never an
 *    edit), stamp reversed_at on the original receipt, recompute receipt_status, one audit entry. */
export async function reverseProductionReceiptInTx(tx: Tx, receiptId: string, actorStaffUserId: string) {
  const [peek] = await tx.select({ batchId: goodsReceipts.productionBatchId }).from(goodsReceipts).where(eq(goodsReceipts.id, receiptId));
  if (!peek?.batchId) throw new ActionError("Penerimaan tidak ditemukan.");
  const batch = await lockProductionBatchForUpdate(tx, peek.batchId);
  if (!batch) throw new Error("production batch not found for an existing receipt");
  const [receipt] = await tx.select().from(goodsReceipts).where(eq(goodsReceipts.id, receiptId)).for("update");
  if (!receipt) throw new ActionError("Penerimaan tidak ditemukan.");
  if (receipt.kind !== "receipt") throw new ActionError("Pembatalan penerimaan tidak bisa dibatalkan lagi.");
  if (receipt.reversedAt !== null) throw new ActionError("Penerimaan ini sudah dibatalkan sebelumnya.");

  const items = await tx.select().from(goodsReceiptItems).where(eq(goodsReceiptItems.goodsReceiptId, receipt.id));
  const itemIds = items.map((item) => item.id);
  const rows = itemIds.length > 0
    ? await tx
        .select()
        .from(stockMovements)
        .where(and(eq(stockMovements.type, "production"), eq(stockMovements.refType, "goods_receipt_item"), inArray(stockMovements.refId, itemIds)))
    : [];
  if (rows.length !== items.length) throw new Error("receipt items and stock rows disagree");

  await lockVariantsInOrder(tx, rows.map((row) => row.sku));
  for (const row of [...rows].sort((a, b) => a.sku.localeCompare(b.sku))) {
    if (await hasLaterBlockingStockMovement(tx, row)) {
      throw new ActionError(
        `Penerimaan ini tidak bisa dibatalkan karena SKU ${row.sku} sudah terjual atau disesuaikan sesudahnya. Gunakan "Sesuaikan stok" untuk mengoreksi jumlahnya.`,
      );
    }
    const balance = await currentBalanceForSkuLocked(tx, row.sku);
    if (balance.qty < row.qty) throw new ActionError("Pembatalan ini akan membuat stok menjadi negatif.");
  }

  const receiptNo = await nextDocumentNumber(tx, "GR", goodsReceipts.receiptNo);
  const [reversal] = await tx
    .insert(goodsReceipts)
    .values({
      receiptNo,
      sourceType: "production_batch",
      productionBatchId: batch.id,
      kind: "reversal",
      receivedAt: todayInJakarta(),
      reversesReceiptId: receipt.id,
      note: `Pembatalan ${receipt.receiptNo}`,
      createdByStaffUserId: actorStaffUserId,
    })
    .returning();
  if (!reversal) throw new Error("failed to insert reversal receipt");

  const reversalItems = await tx
    .insert(goodsReceiptItems)
    .values(
      items.map((item) => ({
        goodsReceiptId: reversal.id,
        sourceType: "production_batch" as const,
        kind: "reversal" as const,
        productionBatchItemId: item.productionBatchItemId,
        qtyAccepted: -item.qtyAccepted,
      })),
    )
    .returning();
  const reversalItemByLine = new Map(reversalItems.map((item) => [item.productionBatchItemId, item.id]));
  const lineByReceiptItem = new Map(items.map((item) => [item.id, item.productionBatchItemId]));
  /** The reversal item negating the receipt item a stock row points at — throws on a miss rather
   * than writing a NULL ref_id, which would slip past the (type, ref_type, ref_id) unique index. */
  const reversalRefFor = (receiptItemId: string | null): string => {
    const line = receiptItemId ? lineByReceiptItem.get(receiptItemId) : undefined;
    const reversalItemId = line ? reversalItemByLine.get(line) : undefined;
    if (!reversalItemId) throw new Error(`no reversal item for receipt item ${receiptItemId}`);
    return reversalItemId;
  };

  const negations = await tx
    .insert(stockMovements)
    .values(
      rows.map((row) => ({
        sku: row.sku,
        qty: -row.qty,
        valueAmount: -row.valueAmount,
        type: "production" as const,
        refType: "goods_receipt_item" as const,
        refId: reversalRefFor(row.refId),
        note: `Pembatalan ${receipt.receiptNo}`,
        createdByStaffUserId: actorStaffUserId,
      })),
    )
    .returning();

  await tx.update(goodsReceipts).set({ reversedAt: new Date(), reversedByStaffUserId: actorStaffUserId }).where(eq(goodsReceipts.id, receipt.id));

  const status = batchStatusAfterReceiptChange(batch.receiptStatus, await getBatchLineProgress(batch.id, tx));
  if (status !== batch.receiptStatus) await tx.update(productionBatches).set({ receiptStatus: status }).where(eq(productionBatches.id, batch.id));

  await writeAuditLog(tx, {
    actorStaffUserId,
    action: "reverse",
    entityType: "goods_receipt",
    entityId: receipt.id,
    before: receipt,
    after: { reversal, items: reversalItems, movements: negations, batchReceiptStatus: { before: batch.receiptStatus, after: status } },
  });
  return { reversal, status };
}

/** §5 `closeBatchShort` (D19/D27): "Tutup batch" with a required reason, for output that will
 * never arrive. Only a posted batch still waiting for output (pending / partially received) can be
 * closed. Moves no stock and changes no cost: HPP/pcs stays frozen, and the planned-but-never-
 * received pcs show as "Nilai belum terserap" on the batch. Always `closed` — a posted batch has
 * already consumed its material, so there is no `cancelled` for batches. */
export async function closeBatchShort(batchId: string, reason: string, actorStaffUserId: string, db: Database = defaultDb) {
  const trimmed = reason.trim();
  if (trimmed === "") throw new FieldError("reason", "Alasan wajib diisi.");

  return db.transaction(async (tx) => {
    const before = await lockProductionBatchForUpdate(tx, batchId);
    if (!before) throw new ActionError("Batch tidak ditemukan.");
    if (before.status !== "posted") throw new ActionError("Batch yang belum diposting tidak bisa ditutup. Hapus drafnya jika tidak jadi.");
    // Decided on the EFFECTIVE status, recomputed under the lock: a batch the previous release
    // posted after migration 0025 is stored 'pending' but its at-posting stock already counts as
    // fully received, and must not be stamped closed with nothing outstanding.
    if (!isOpenBatchReceiptStatus(before.receiptStatus) || batchReceiptProgressStatus(await getBatchLineProgress(batchId, tx)) === "received") {
      throw new ActionError("Batch ini sudah diterima lengkap atau sudah ditutup.");
    }

    const [after] = await tx
      .update(productionBatches)
      .set({ receiptStatus: "closed", closedAt: new Date(), closedByStaffUserId: actorStaffUserId, closeReason: trimmed })
      .where(eq(productionBatches.id, batchId))
      .returning();
    if (!after) throw new Error("failed to close production batch");

    await writeAuditLog(tx, { actorStaffUserId, action: "close", entityType: "production_batch", entityId: batchId, before, after });
    return after;
  });
}

// ---------- Reads ----------

export interface BatchReceiptLine {
  id: string;
  sku: string;
  productName: string;
  colorName: string;
  size: string;
  planned: number;
  received: number;
  outstanding: number;
}

export interface BatchReceiptSummary {
  /** The EFFECTIVE status: the stored one, except that an open stored status is re-derived from
   * the lines. They only ever differ for a batch the previous release posted after migration 0025
   * (stored 'pending', but its at-posting stock already counts as received), which must not be
   * offered a receipt or a close. */
  receiptStatus: ProductionReceiptStatus;
  closedAt: Date | null;
  closedByName: string | null;
  closeReason: string | null;
  lines: BatchReceiptLine[];
}

/** The "Hasil produksi" panel's data: per variant, planned / received / outstanding. No cost
 * columns at all — safe for every caller. */
export async function getBatchReceiptSummary(batchId: string, db: Database = defaultDb): Promise<BatchReceiptSummary | null> {
  const closedBy = alias(staffUsers, "closed_by");
  const [header] = await db
    .select({
      receiptStatus: productionBatches.receiptStatus,
      closedAt: productionBatches.closedAt,
      closedByName: closedBy.name,
      closeReason: productionBatches.closeReason,
    })
    .from(productionBatches)
    .leftJoin(closedBy, eq(closedBy.id, productionBatches.closedByStaffUserId))
    .where(eq(productionBatches.id, batchId))
    .limit(1);
  if (!header) return null;

  const [lineRows, received] = await Promise.all([
    batchLinesQuery(db, batchId).orderBy(products.name, fabricColors.name, productVariants.size),
    getBatchReceivedByLine(batchId, db),
  ]);
  const progress = lineRows.map((row) => ({ planned: row.qty, received: received.get(row.id) ?? 0 }));
  return {
    ...header,
    receiptStatus: isOpenBatchReceiptStatus(header.receiptStatus) ? batchReceiptProgressStatus(progress) : header.receiptStatus,
    lines: lineRows.map((row) => {
      const lineReceived = received.get(row.id) ?? 0;
      return {
        id: row.id,
        sku: row.sku,
        productName: row.productName,
        colorName: row.colorName,
        size: row.size,
        planned: row.qty,
        received: lineReceived,
        outstanding: row.qty - lineReceived,
      };
    }),
  };
}

/** "Nilai belum terserap" (§4.3): the frozen cost of the planned pcs that never arrived on a
 * short-closed batch, Σ outstanding × unit_cost_amount. Cost data: callers gate it behind
 * finance.view_profit (rendered only inside BatchCostsSection). */
export function unabsorbedValue(lines: readonly { outstanding: number; unitCostAmount: number }[]): number {
  return lines.reduce((sum, line) => sum + Math.max(0, line.outstanding) * line.unitCostAmount, 0);
}

export interface BatchReceiptItemRow {
  productionBatchItemId: string;
  sku: string;
  label: string;
  qtyAccepted: number;
}

export interface BatchReceiptRow {
  id: string;
  receiptNo: string;
  kind: GoodsReceiptKind;
  receivedAt: string;
  receivedByName: string | null;
  note: string | null;
  createdAt: Date;
  createdByName: string | null;
  reversedAt: Date | null;
  reversesReceiptNo: string | null;
  items: BatchReceiptItemRow[];
}

/** Every receipt and reversal of one batch, newest first, each with its lines. */
export async function listReceiptsForBatch(batchId: string, db: Database = defaultDb): Promise<BatchReceiptRow[]> {
  const reversed = alias(goodsReceipts, "reversed");
  const headers = await db
    .select({
      id: goodsReceipts.id,
      receiptNo: goodsReceipts.receiptNo,
      kind: goodsReceipts.kind,
      receivedAt: goodsReceipts.receivedAt,
      receivedByName: goodsReceipts.receivedByName,
      note: goodsReceipts.note,
      createdAt: goodsReceipts.createdAt,
      createdByName: staffUsers.name,
      reversedAt: goodsReceipts.reversedAt,
      reversesReceiptNo: reversed.receiptNo,
    })
    .from(goodsReceipts)
    .leftJoin(staffUsers, eq(staffUsers.id, goodsReceipts.createdByStaffUserId))
    .leftJoin(reversed, eq(reversed.id, goodsReceipts.reversesReceiptId))
    .where(eq(goodsReceipts.productionBatchId, batchId))
    .orderBy(desc(goodsReceipts.createdAt), desc(goodsReceipts.id));
  if (headers.length === 0) return [];

  const itemRows = await db
    .select({
      goodsReceiptId: goodsReceiptItems.goodsReceiptId,
      productionBatchItemId: goodsReceiptItems.productionBatchItemId,
      qtyAccepted: goodsReceiptItems.qtyAccepted,
      sku: productionBatchItems.sku,
      productName: products.name,
      colorName: fabricColors.name,
      size: productVariants.size,
    })
    .from(goodsReceiptItems)
    .innerJoin(productionBatchItems, eq(productionBatchItems.id, goodsReceiptItems.productionBatchItemId))
    .innerJoin(productVariants, eq(productVariants.sku, productionBatchItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(inArray(goodsReceiptItems.goodsReceiptId, headers.map((header) => header.id)))
    .orderBy(asc(products.name), asc(fabricColors.name), asc(productVariants.size));

  const itemsByReceipt = new Map<string, BatchReceiptItemRow[]>();
  for (const row of itemRows) {
    const list = itemsByReceipt.get(row.goodsReceiptId) ?? [];
    list.push({ productionBatchItemId: row.productionBatchItemId!, sku: row.sku, label: lineLabel(row), qtyAccepted: row.qtyAccepted });
    itemsByReceipt.set(row.goodsReceiptId, list);
  }
  return headers.map((header) => ({ ...header, items: itemsByReceipt.get(header.id) ?? [] }));
}

export interface UnreceivedBatchForProduct {
  id: string;
  batchNo: string;
  producedAt: string;
  receiptStatus: ProductionReceiptStatus;
  /** Planned-but-not-yet-received pcs of THIS product in the batch. */
  outstandingPcs: number;
}

/** The stock-count guard (§6, S4): posted batches that include this product and whose output for
 * it is not fully received yet. Goods physically in the house but not received read as missing,
 * and "correcting" them by a count would detach them from their batch and its HPP for good. */
export async function listUnreceivedBatchesForProduct(productId: string, db: Database = defaultDb): Promise<UnreceivedBatchForProduct[]> {
  const rows = await db
    .select({
      id: productionBatches.id,
      batchNo: productionBatches.batchNo,
      producedAt: productionBatches.producedAt,
      receiptStatus: productionBatches.receiptStatus,
      lineId: productionBatchItems.id,
      qty: productionBatchItems.qty,
    })
    .from(productionBatches)
    .innerJoin(productionBatchItems, eq(productionBatchItems.productionBatchId, productionBatches.id))
    .innerJoin(productVariants, eq(productVariants.sku, productionBatchItems.sku))
    .where(
      and(
        eq(productionBatches.status, "posted"),
        inArray(productionBatches.receiptStatus, ["pending", "partially_received"]),
        eq(productVariants.productId, productId),
      ),
    )
    .orderBy(asc(productionBatches.producedAt), asc(productionBatches.batchNo));

  const byBatch = new Map<string, UnreceivedBatchForProduct & { lines: { id: string; qty: number }[] }>();
  for (const row of rows) {
    const entry = byBatch.get(row.id) ?? { id: row.id, batchNo: row.batchNo, producedAt: row.producedAt, receiptStatus: row.receiptStatus, outstandingPcs: 0, lines: [] };
    entry.lines.push({ id: row.lineId, qty: row.qty });
    byBatch.set(row.id, entry);
  }

  const received = await getReceivedByLineForBatches([...byBatch.keys()], db);
  const result: UnreceivedBatchForProduct[] = [];
  for (const entry of byBatch.values()) {
    const outstandingPcs = entry.lines.reduce((sum, line) => sum + line.qty - (received.get(line.id) ?? 0), 0);
    // A batch whose lines for this product are all in already (only its OTHER products are
    // outstanding, or a legacy at-posting row covers it) is not a trap for this count.
    if (outstandingPcs > 0) result.push({ id: entry.id, batchNo: entry.batchNo, producedAt: entry.producedAt, receiptStatus: entry.receiptStatus, outstandingPcs });
  }
  return result;
}
