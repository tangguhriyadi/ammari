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
import { getDefectSettledByBatchLine, insertRejectMovements, reverseRejectsInTx } from "@/lib/defects/queries";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { nextDocumentNumber } from "@/lib/documents/document-number";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { lockProductionBatchForUpdate } from "@/lib/production/db";
import { batchReceiptProgressStatus, batchStatusAfterReceiptChange, isOpenBatchReceiptStatus, type BatchLineProgress } from "@/lib/production/receipt-status";
import { lockVariantForUpdate } from "@/lib/stock/db";
import { currentBalanceForSkuLocked } from "@/lib/stock/queries";
import { assertReceivedAt } from "./received-at";

// Goods receipts of production output (docs/plans/suppliers-goods-receipt.md §5, sessions S4 +
// S5). Posting a batch consumes material and freezes HPP but no longer adds finished-goods stock
// (D4); a receipt here is the ONLY way a batch's output enters sellable stock (D3). Rejected pcs
// (S5) go to the defect ledger at the same frozen unit cost, never to sellable stock.
//
// Legacy batches: releases before S4 wrote one 'production' stock_movements row per line AT
// POSTING (ref_type 'production_batch_item'). Those rows count as received for their line, so a
// legacy batch is always fully received here, never offered a receipt, and never double counted —
// including one posted by the previous release after migration 0025 ran (which the migration's
// receipt_status backfill can't have seen).

export interface BatchReceiptLineInput {
  productionBatchItemId: string;
  qtyAccepted: number;
  /** Pcs that arrived defective ("Ditolak (cacat)"); 0 when omitted. */
  qtyRejected?: number;
}

export interface PostBatchReceiptInput {
  batchId: string;
  receivedAt: string;
  receivedByName?: string | null;
  note?: string | null;
  lines: BatchReceiptLineInput[];
}

export interface BatchLineQuantities {
  /** Net pcs accepted into sellable stock: receipt items (receipts minus reversals) plus legacy
   * at-posting stock rows. Shown as "Diterima". */
  received: number;
  /** Net pcs rejected into defect stock at receipt (S5). Shown as "Cacat". */
  rejected: number;
  /** §4.2/D16 qtySettled = received + rejected − returned out (net of reversals): what has used up
   * the line's planned pcs. Outstanding is always planned − settled. */
  settled: number;
}

const NO_QUANTITIES: BatchLineQuantities = { received: 0, rejected: 0, settled: 0 };

/** Per batch line, for every line of the given batches. Always SUMs, never a stored counter — a
 * fixed number of grouped queries whatever the number of batches. Safe to call unlocked for
 * display; a write that decides on it must have locked the batch row first. */
export async function getBatchLineQuantities(batchIds: readonly string[], db: Database = defaultDb): Promise<Map<string, BatchLineQuantities>> {
  if (batchIds.length === 0) return new Map();
  const lineIds = (
    await db.select({ id: productionBatchItems.id }).from(productionBatchItems).where(inArray(productionBatchItems.productionBatchId, [...batchIds]))
  ).map((row) => row.id);
  if (lineIds.length === 0) return new Map();

  const [receiptRows, legacyRows, defectSettled] = await Promise.all([
    db
      .select({
        lineId: goodsReceiptItems.productionBatchItemId,
        qty: sql<string>`sum(${goodsReceiptItems.qtyAccepted})`,
        rejected: sql<string>`sum(${goodsReceiptItems.qtyRejected})`,
      })
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
    getDefectSettledByBatchLine(lineIds, db),
  ]);

  const received = new Map<string, number>(lineIds.map((id) => [id, 0]));
  for (const row of [...receiptRows, ...legacyRows]) {
    if (row.lineId) received.set(row.lineId, (received.get(row.lineId) ?? 0) + Number(row.qty));
  }
  const rejected = new Map(receiptRows.map((row) => [row.lineId!, Number(row.rejected)]));
  return new Map(
    lineIds.map((id) => {
      const lineReceived = received.get(id) ?? 0;
      return [id, { received: lineReceived, rejected: rejected.get(id) ?? 0, settled: lineReceived + (defectSettled.get(id)?.qty ?? 0) }];
    }),
  );
}

/** {@link getBatchLineQuantities} for one batch. */
export async function getBatchQuantitiesByLine(batchId: string, db: Database = defaultDb): Promise<Map<string, BatchLineQuantities>> {
  return getBatchLineQuantities([batchId], db);
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
  const [lines, quantities] = await Promise.all([
    db
      .select({ id: productionBatchItems.id, batchId: productionBatchItems.productionBatchId, qty: productionBatchItems.qty })
      .from(productionBatchItems)
      .where(inArray(productionBatchItems.productionBatchId, openIds)),
    getBatchLineQuantities(openIds, db),
  ]);
  const progressByBatch = new Map<string, BatchLineProgress[]>();
  for (const line of lines) {
    const list = progressByBatch.get(line.batchId) ?? [];
    const { received, rejected } = quantities.get(line.id) ?? NO_QUANTITIES;
    list.push({ planned: line.qty, received, rejected });
    progressByBatch.set(line.batchId, list);
  }
  for (const id of openIds) result.set(id, batchReceiptProgressStatus(progressByBatch.get(id) ?? []));
  return result;
}

async function getBatchLineProgress(batchId: string, db: Database): Promise<BatchLineProgress[]> {
  const [lines, quantities] = await Promise.all([
    db.select({ id: productionBatchItems.id, qty: productionBatchItems.qty }).from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, batchId)),
    getBatchQuantitiesByLine(batchId, db),
  ]);
  return lines.map((line) => {
    const { received, rejected } = quantities.get(line.id) ?? NO_QUANTITIES;
    return { planned: line.qty, received, rejected };
  });
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
 * 3. recompute qtySettled/outstanding per line INSIDE the lock and reject over-receipt (D17:
 *    accepted + rejected together may not exceed what is left) with a message naming the line and
 *    what is left, and reject a receipt where every line is zero;
 * 4. lock the variant rows in sorted SKU order;
 * 5. insert the receipt header and its items;
 * 6. per line, one 'production' stock_movements row for the accepted pcs (ref_type
 *    'goods_receipt_item', ref_id = the receipt item, value = qty × the line's frozen
 *    unit_cost_amount — HPP is never recomputed) and one 'reject' defect row for the rejected pcs
 *    at the same unit cost (they cost the same to make, §4.2);
 * 7. recompute and store receipt_status (never `status`, D5);
 * 8. one audit entry for the whole receipt. */
export async function postGoodsReceiptForBatch(input: PostBatchReceiptInput, actorStaffUserId: string, db: Database = defaultDb) {
  assertReceivedAt(input.receivedAt);
  const requested = input.lines
    .map((line) => ({ ...line, qtyRejected: line.qtyRejected ?? 0 }))
    .filter((line) => line.qtyAccepted !== 0 || line.qtyRejected !== 0);
  if (requested.length === 0) throw new FieldError("lines", "Isi jumlah diterima minimal untuk satu SKU.");
  const seen = new Set<string>();
  for (const line of requested) {
    if (!Number.isSafeInteger(line.qtyAccepted) || line.qtyAccepted < 0) throw new FieldError("lines", "Jumlah diterima harus bilangan bulat.");
    if (!Number.isSafeInteger(line.qtyRejected) || line.qtyRejected < 0) throw new FieldError("lines", "Jumlah ditolak harus bilangan bulat.");
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
    const quantitiesBefore = await getBatchQuantitiesByLine(batch.id, tx);

    const planned = requested.map((request) => {
      const line = linesById.get(request.productionBatchItemId);
      if (!line) throw new FieldError("lines", "SKU ini bukan bagian dari batch.");
      const outstanding = line.qty - (quantitiesBefore.get(line.id)?.settled ?? 0);
      // D17: accepted AND rejected both use up what is left; over-receipt is refused entirely.
      if (request.qtyAccepted + request.qtyRejected > outstanding) {
        throw new FieldError(
          "lines",
          outstanding <= 0
            ? `${lineLabel(line)} sudah diterima lengkap, tidak bisa menerima lagi.`
            : request.qtyRejected === 0
              ? `Jumlah diterima untuk ${lineLabel(line)} melebihi sisa batch. Sisa yang belum diterima: ${outstanding} pcs.`
              : `Jumlah diterima ditambah ditolak untuk ${lineLabel(line)} melebihi sisa batch. Sisa yang belum diterima: ${outstanding} pcs.`,
        );
      }
      return { line, qtyAccepted: request.qtyAccepted, qtyRejected: request.qtyRejected };
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
          qtyAccepted: plan.qtyAccepted,
          qtyRejected: plan.qtyRejected,
        })),
      )
      .returning();
    const itemByLine = new Map(items.map((item) => [item.productionBatchItemId!, item]));
    const note = `${batch.batchNo} · ${receiptNo}`;

    const accepted = planned.filter((plan) => plan.qtyAccepted > 0);
    const movements =
      accepted.length === 0
        ? []
        : await tx
            .insert(stockMovements)
            .values(
              accepted.map((plan) => ({
                sku: plan.line.sku,
                qty: plan.qtyAccepted,
                valueAmount: plan.qtyAccepted * plan.line.unitCostAmount,
                type: "production" as const,
                refType: "goods_receipt_item" as const,
                refId: itemByLine.get(plan.line.id)!.id,
                note,
                createdByStaffUserId: actorStaffUserId,
              })),
            )
            .returning();
    const defects = await insertRejectMovements(
      tx,
      planned
        .filter((plan) => plan.qtyRejected > 0)
        .map((plan) => ({
          item: { kind: "sku" as const, sku: plan.line.sku },
          source: { productionBatchItemId: plan.line.id },
          goodsReceiptItemId: itemByLine.get(plan.line.id)!.id,
          qty: plan.qtyRejected,
          valueAmount: plan.qtyRejected * plan.line.unitCostAmount,
          occurredAt: input.receivedAt,
          note,
        })),
      actorStaffUserId,
    );

    const receiptStatus = batchStatusAfterReceiptChange(batch.receiptStatus, await getBatchLineProgress(batch.id, tx));
    if (receiptStatus !== batch.receiptStatus) {
      await tx.update(productionBatches).set({ receiptStatus }).where(eq(productionBatches.id, batch.id));
    }

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "receive",
      entityType: "goods_receipt",
      entityId: receipt.id,
      after: { receipt, items, movements, defects, batchReceiptStatus: { before: batch.receiptStatus, after: receiptStatus } },
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
 *    stok"), and — as a backstop — if reversing would take a SKU's balance negative; and reject if
 *    the receipt's defects have since been returned or released (reverseRejectsInTx);
 * 4. insert a kind='reversal' receipt whose items are the exact negation (accepted AND rejected),
 *    one exactly negated 'production' stock row per original row (stock_movements is append-only:
 *    a new row, never an edit), one exact 'reversal' defect row per original 'reject' row, stamp
 *    reversed_at on the originals, recompute receipt_status, one audit entry. */
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
  // A line that only rejected (accepted 0) has no stock row.
  if (rows.length !== items.filter((item) => item.qtyAccepted !== 0).length) throw new Error("receipt items and stock rows disagree");

  const lineSkus = await tx
    .select({ sku: productionBatchItems.sku })
    .from(productionBatchItems)
    .where(inArray(productionBatchItems.id, items.flatMap((item) => (item.productionBatchItemId ? [item.productionBatchItemId] : []))));
  await lockVariantsInOrder(tx, lineSkus.map((row) => row.sku));
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
        qtyRejected: -item.qtyRejected,
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

  const negations =
    rows.length === 0
      ? []
      : await tx
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

  const { reversals: defectReversals } = await reverseRejectsInTx(
    tx,
    { items, reversalItemIdFor: reversalRefFor, occurredAt: reversal.receivedAt, note: `Pembatalan ${receipt.receiptNo}` },
    actorStaffUserId,
  );

  await tx.update(goodsReceipts).set({ reversedAt: new Date(), reversedByStaffUserId: actorStaffUserId }).where(eq(goodsReceipts.id, receipt.id));

  const status = batchStatusAfterReceiptChange(batch.receiptStatus, await getBatchLineProgress(batch.id, tx));
  if (status !== batch.receiptStatus) await tx.update(productionBatches).set({ receiptStatus: status }).where(eq(productionBatches.id, batch.id));

  await writeAuditLog(tx, {
    actorStaffUserId,
    action: "reverse",
    entityType: "goods_receipt",
    entityId: receipt.id,
    before: receipt,
    after: { reversal, items: reversalItems, movements: negations, defectReversals, batchReceiptStatus: { before: batch.receiptStatus, after: status } },
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
  /** Net pcs rejected into defect stock ("Cacat"). */
  rejected: number;
  /** planned − qtySettled (§4.2): rejects use up the planned pcs too. */
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

  const [lineRows, quantities] = await Promise.all([
    batchLinesQuery(db, batchId).orderBy(products.name, fabricColors.name, productVariants.size),
    getBatchQuantitiesByLine(batchId, db),
  ]);
  const progress = lineRows.map((row) => {
    const { received, rejected } = quantities.get(row.id) ?? NO_QUANTITIES;
    return { planned: row.qty, received, rejected };
  });
  return {
    ...header,
    receiptStatus: isOpenBatchReceiptStatus(header.receiptStatus) ? batchReceiptProgressStatus(progress) : header.receiptStatus,
    lines: lineRows.map((row) => {
      const { received, rejected, settled } = quantities.get(row.id) ?? NO_QUANTITIES;
      return {
        id: row.id,
        sku: row.sku,
        productName: row.productName,
        colorName: row.colorName,
        size: row.size,
        planned: row.qty,
        received,
        rejected,
        outstanding: row.qty - settled,
      };
    }),
  };
}

/** "Nilai belum terserap" (§4.3): the frozen cost of the planned pcs that never arrived at all
 * (neither good nor defective — rejects are carried in defect stock) on a short-closed batch, Σ outstanding × unit_cost_amount. Cost data: callers gate it behind
 * finance.view_profit (rendered only inside BatchCostsSection). */
export function unabsorbedValue(lines: readonly { outstanding: number; unitCostAmount: number }[]): number {
  return lines.reduce((sum, line) => sum + Math.max(0, line.outstanding) * line.unitCostAmount, 0);
}

export interface BatchReceiptItemRow {
  productionBatchItemId: string;
  sku: string;
  label: string;
  qtyAccepted: number;
  qtyRejected: number;
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
      qtyRejected: goodsReceiptItems.qtyRejected,
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
    list.push({ productionBatchItemId: row.productionBatchItemId!, sku: row.sku, label: lineLabel(row), qtyAccepted: row.qtyAccepted, qtyRejected: row.qtyRejected });
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

  const quantities = await getBatchLineQuantities([...byBatch.keys()], db);
  const result: UnreceivedBatchForProduct[] = [];
  for (const entry of byBatch.values()) {
    // Settled, not just accepted: rejected pcs are already recorded (in defect stock).
    const outstandingPcs = entry.lines.reduce((sum, line) => sum + line.qty - (quantities.get(line.id)?.settled ?? 0), 0);
    // A batch whose lines for this product are all in already (only its OTHER products are
    // outstanding, or a legacy at-posting row covers it) is not a trap for this count.
    if (outstandingPcs > 0) result.push({ id: entry.id, batchNo: entry.batchNo, producedAt: entry.producedAt, receiptStatus: entry.receiptStatus, outstandingPcs });
  }
  return result;
}
