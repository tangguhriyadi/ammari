import "server-only";
import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  accessories,
  defectMovements,
  fabricColors,
  fabrics,
  goodsReceiptItems,
  goodsReceipts,
  productionBatchCosts,
  productionBatches,
  productionBatchItems,
  purchaseItems,
  stockMovements,
  supplierPayments,
} from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";
import type { Database } from "./ledger-write";
import type { DefectDisposalSnapshot, FinishedGoodsAdjustmentSnapshot } from "./rules/inventory";
import type { ProductionBatchSnapshot, ProductionDefectReturnSnapshot } from "./rules/production";

// Snapshot loaders for the Session 8 rules (production batches R1-R5, finished-goods adjustments A1,
// defect releases A2). Read-only: the ledger is derived from these records and never writes them.

const toNumber = (value: string | number | null): number | null => (value === null ? null : Number(value));

/** Every posted batch (and every draft that has a payment, so a payment on it is never lost) with
 * its consumption, cost lines, production receipts, payments and returns to the tailor. */
export async function loadProductionBatchSnapshots(db: Database): Promise<ProductionBatchSnapshot[]> {
  const batchId = qualifiedColumn(productionBatches, productionBatches.id);
  const batches = await db
    .select({
      id: productionBatches.id,
      batchNo: productionBatches.batchNo,
      status: productionBatches.status,
      postedAt: productionBatches.postedAt,
      receiptStatus: productionBatches.receiptStatus,
      closedAt: productionBatches.closedAt,
      // Value of a consumption row is <= 0; the cost it represents is its negation.
      fabricConsumed: sql<string | null>`(select -sum(m.value_amount) from fabric_stock_movements m where m.type = 'production' and m.ref_type = 'production_batch' and m.ref_id = ${batchId}::text)`,
      accessoryConsumed: sql<string>`(select coalesce(-sum(m.value_amount), 0) from accessory_movements m where m.type = 'production' and m.ref_type = 'production_batch' and m.ref_id = ${batchId}::text)`,
      hasLegacyStock: sql<boolean>`exists (select 1 from production_batch_items pbi join stock_movements sm on sm.ref_type = 'production_batch_item' and sm.ref_id = pbi.id::text where pbi.production_batch_id = ${batchId})`,
    })
    .from(productionBatches)
    .where(or(eq(productionBatches.status, "posted"), sql`exists (select 1 from supplier_payments sp where sp.production_batch_id = ${batchId})`))
    .orderBy(asc(productionBatches.createdAt), asc(productionBatches.id));
  if (batches.length === 0) return [];
  // Only the loaded batches' rows (drafts' cost lines and the like are never read).
  const ids = batches.map((batch) => batch.id);

  const costRows = await db
    .select({ batchId: productionBatchCosts.productionBatchId, supplierId: productionBatchCosts.supplierId, supplierName: productionBatchCosts.supplierName, total: productionBatchCosts.total })
    .from(productionBatchCosts)
    .where(inArray(productionBatchCosts.productionBatchId, ids))
    .orderBy(asc(productionBatchCosts.createdAt), asc(productionBatchCosts.id));

  const receiptItemId = qualifiedColumn(goodsReceiptItems, goodsReceiptItems.id);
  const originalItem = alias(goodsReceiptItems, "original_item");
  const receiptRows = await db
    .select({
      batchId: goodsReceipts.productionBatchId,
      id: goodsReceiptItems.id,
      receiptNo: goodsReceipts.receiptNo,
      kind: goodsReceiptItems.kind,
      receivedAt: goodsReceipts.receivedAt,
      createdAt: goodsReceipts.createdAt,
      reversesItemId: originalItem.id,
      sku: productionBatchItems.sku,
      qtyAccepted: goodsReceiptItems.qtyAccepted,
      qtyRejected: goodsReceiptItems.qtyRejected,
      acceptedValue: sql<string | null>`(select sum(sm.value_amount) from ${stockMovements} sm where sm.type = 'production' and sm.ref_type = 'goods_receipt_item' and sm.ref_id = ${receiptItemId}::text)`,
      rejectValue: sql<string | null>`(select sum(d.value_amount) from ${defectMovements} d where d.goods_receipt_item_id = ${receiptItemId})`,
    })
    .from(goodsReceiptItems)
    .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptItems.goodsReceiptId))
    .innerJoin(productionBatchItems, eq(productionBatchItems.id, goodsReceiptItems.productionBatchItemId))
    .leftJoin(
      originalItem,
      and(eq(originalItem.goodsReceiptId, goodsReceipts.reversesReceiptId), eq(originalItem.productionBatchItemId, goodsReceiptItems.productionBatchItemId)),
    )
    .where(and(eq(goodsReceiptItems.sourceType, "production_batch"), inArray(goodsReceipts.productionBatchId, ids)))
    .orderBy(asc(goodsReceipts.createdAt), asc(goodsReceiptItems.id));

  const paymentRows = await db
    .select({
      batchId: supplierPayments.productionBatchId,
      id: supplierPayments.id,
      paymentNo: supplierPayments.paymentNo,
      supplierId: supplierPayments.supplierId,
      supplierName: supplierPayments.supplierName,
      paidAt: supplierPayments.paidAt,
      createdAt: supplierPayments.createdAt,
      amount: supplierPayments.amount,
      method: supplierPayments.method,
      voidedAt: supplierPayments.voidedAt,
    })
    .from(supplierPayments)
    .where(and(eq(supplierPayments.targetType, "production_batch"), inArray(supplierPayments.productionBatchId, ids)))
    .orderBy(asc(supplierPayments.createdAt), asc(supplierPayments.id));

  const reversed = alias(defectMovements, "reversed_movement");
  const returnRows = await db
    .select({
      batchId: productionBatchItems.productionBatchId,
      id: defectMovements.id,
      type: defectMovements.type,
      reversesMovementId: defectMovements.reversesMovementId,
      occurredAt: defectMovements.occurredAt,
      createdAt: defectMovements.createdAt,
      valueAmount: defectMovements.valueAmount,
      sku: productionBatchItems.sku,
    })
    .from(defectMovements)
    .innerJoin(productionBatchItems, eq(productionBatchItems.id, defectMovements.productionBatchItemId))
    .leftJoin(reversed, eq(reversed.id, defectMovements.reversesMovementId))
    .where(and(inArray(productionBatchItems.productionBatchId, ids), or(eq(defectMovements.type, "return_out"), and(eq(defectMovements.type, "reversal"), eq(reversed.type, "return_out")))))
    .orderBy(asc(defectMovements.createdAt), asc(defectMovements.id));

  const byId = new Map<string, ProductionBatchSnapshot>(
    batches.map(({ fabricConsumed, accessoryConsumed, ...batch }) => [
      batch.id,
      { ...batch, fabricConsumed: toNumber(fabricConsumed), accessoryConsumed: Number(accessoryConsumed), costLines: [], receiptItems: [], payments: [], defectReturns: [] },
    ]),
  );
  for (const { batchId: id, ...line } of costRows) byId.get(id)?.costLines.push(line);
  for (const { batchId: id, acceptedValue, rejectValue, ...row } of receiptRows) {
    if (!id) continue;
    byId.get(id)?.receiptItems.push({ ...row, acceptedValue: toNumber(acceptedValue), rejectValue: toNumber(rejectValue) });
  }
  for (const { batchId: id, ...row } of paymentRows) {
    if (id) byId.get(id)?.payments.push(row);
  }
  for (const { batchId: id, type, ...row } of returnRows) {
    if (type !== "return_out" && type !== "reversal") continue;
    byId.get(id)?.defectReturns.push({ ...row, type } satisfies ProductionDefectReturnSnapshot);
  }
  return [...byId.values()];
}

/** Finished-goods adjustments (A1). */
export async function loadFinishedGoodsAdjustmentSnapshots(db: Database): Promise<FinishedGoodsAdjustmentSnapshot[]> {
  return db
    .select({
      id: stockMovements.id,
      sku: stockMovements.sku,
      reason: stockMovements.reason,
      qty: stockMovements.qty,
      valueAmount: stockMovements.valueAmount,
      createdAt: stockMovements.createdAt,
    })
    .from(stockMovements)
    .where(eq(stockMovements.type, "adjustment"))
    .orderBy(asc(stockMovements.createdAt), asc(stockMovements.id));
}

/** Defect releases and their reversals (A2), for every source line (purchase or production). */
export async function loadDefectDisposalSnapshots(db: Database): Promise<DefectDisposalSnapshot[]> {
  const itemName = sql<string>`coalesce(
    ${defectMovements.sku},
    ${fabrics.name} || coalesce(' ' || ${fabricColors.name}::text, ''),
    ${accessories.name}::text,
    'Barang cacat'
  )`;
  const rows = await db
    .select({
      id: defectMovements.id,
      type: defectMovements.type,
      reversesMovementId: defectMovements.reversesMovementId,
      disposalType: defectMovements.disposalType,
      occurredAt: defectMovements.occurredAt,
      valueAmount: defectMovements.valueAmount,
      proceedsAmount: defectMovements.proceedsAmount,
      itemName,
    })
    .from(defectMovements)
    .leftJoin(purchaseItems, eq(purchaseItems.id, defectMovements.purchaseItemId))
    .leftJoin(fabrics, eq(fabrics.id, defectMovements.fabricId))
    .leftJoin(fabricColors, eq(fabricColors.id, purchaseItems.fabricColorId))
    .leftJoin(accessories, eq(accessories.id, defectMovements.accessoryId))
    // Releases and their reversals are exactly the rows with a disposal type (0026 CHECKs).
    .where(isNotNull(defectMovements.disposalType))
    .orderBy(asc(defectMovements.createdAt), asc(defectMovements.id));
  const snapshots: DefectDisposalSnapshot[] = [];
  for (const { type, disposalType, proceedsAmount, ...row } of rows) {
    if ((type !== "dispose" && type !== "reversal") || !disposalType) continue;
    snapshots.push({ ...row, type, disposalType, proceedsAmount: proceedsAmount ?? 0, itemName: String(row.itemName) });
  }
  return snapshots;
}
