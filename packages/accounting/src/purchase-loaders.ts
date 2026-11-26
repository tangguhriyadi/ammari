import "server-only";
import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  accessories,
  accessoryMovements,
  defectMovements,
  fabricColors,
  fabricStockMovements,
  fabrics,
  goodsReceiptItems,
  goodsReceipts,
  purchaseItems,
  purchases,
  supplierPayments,
  suppliers,
} from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";
import type { Database } from "./ledger-write";
import type { PurchaseDefectReturnSnapshot, PurchaseDocumentSnapshot, PurchasePaymentSnapshot, PurchaseReceiptItemSnapshot } from "./rules/purchases";
import { markReclassifications, type RawMaterialMovementSnapshot } from "./rules/raw-materials";

// Snapshot loaders for the Session 7 rules (purchase document chain, raw-material adjustments).
// Read-only: the ledger is derived from these records and never writes them (plan §2).

const toNumber = (value: string | number | null): number | null => (value === null ? null : Number(value));

/** "Katun Jepang Hitam" / "Kancing": the line's item, for descriptions and memos. */
const lineItemName = sql<string>`coalesce(
  ${fabrics.name} || coalesce(' ' || ${fabricColors.name}::text, ''),
  ${accessories.name}::text,
  'Barang'
)`;

/** Every purchase document with its receipts, payments and returns-to-supplier. */
export async function loadPurchaseDocumentSnapshots(db: Database): Promise<PurchaseDocumentSnapshot[]> {
  const documents = await db
    .select({
      id: purchases.id,
      purchaseNo: purchases.purchaseNo,
      supplierId: purchases.supplierId,
      supplierName: sql<string>`${suppliers.name}::text`,
      status: purchases.status,
      closedAt: purchases.closedAt,
    })
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .orderBy(asc(purchases.createdAt), asc(purchases.id));
  if (documents.length === 0) return [];

  const originalItem = alias(goodsReceiptItems, "original_item");
  // Qualified: these correlate the subqueries below with the outer row (sql-helpers.ts).
  const receiptItemId = qualifiedColumn(goodsReceiptItems, goodsReceiptItems.id);
  const receiptRows = await db
    .select({
      purchaseId: goodsReceipts.purchaseId,
      id: goodsReceiptItems.id,
      receiptNo: goodsReceipts.receiptNo,
      kind: goodsReceiptItems.kind,
      receivedAt: goodsReceipts.receivedAt,
      createdAt: goodsReceipts.createdAt,
      reversesItemId: originalItem.id,
      itemType: purchaseItems.itemType,
      itemName: lineItemName,
      qtyAccepted: goodsReceiptItems.qtyAccepted,
      qtyRejected: goodsReceiptItems.qtyRejected,
      // ref_id is text; each item writes at most one raw-ledger row (the per-type unique index).
      acceptedValue: sql<string | null>`case ${qualifiedColumn(purchaseItems, purchaseItems.itemType)}
        when 'fabric' then (select sum(m.value_amount) from ${fabricStockMovements} m where m.ref_type = 'goods_receipt' and m.ref_id = ${receiptItemId}::text)
        else (select sum(m.value_amount) from ${accessoryMovements} m where m.ref_type = 'goods_receipt' and m.ref_id = ${receiptItemId}::text)
      end`,
      rejectValue: sql<string | null>`(select sum(d.value_amount) from ${defectMovements} d where d.goods_receipt_item_id = ${receiptItemId})`,
    })
    .from(goodsReceiptItems)
    .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptItems.goodsReceiptId))
    .innerJoin(purchaseItems, eq(purchaseItems.id, goodsReceiptItems.purchaseItemId))
    .leftJoin(fabrics, eq(fabrics.id, purchaseItems.fabricId))
    .leftJoin(fabricColors, eq(fabricColors.id, purchaseItems.fabricColorId))
    .leftJoin(accessories, eq(accessories.id, purchaseItems.accessoryId))
    .leftJoin(originalItem, and(eq(originalItem.goodsReceiptId, goodsReceipts.reversesReceiptId), eq(originalItem.purchaseItemId, goodsReceiptItems.purchaseItemId)))
    .where(eq(goodsReceiptItems.sourceType, "purchase"))
    .orderBy(asc(goodsReceipts.createdAt), asc(goodsReceiptItems.id));

  const paymentRows = await db
    .select({
      purchaseId: supplierPayments.purchaseId,
      id: supplierPayments.id,
      paymentNo: supplierPayments.paymentNo,
      paidAt: supplierPayments.paidAt,
      createdAt: supplierPayments.createdAt,
      amount: supplierPayments.amount,
      method: supplierPayments.method,
      voidedAt: supplierPayments.voidedAt,
    })
    .from(supplierPayments)
    .where(eq(supplierPayments.targetType, "purchase"))
    .orderBy(asc(supplierPayments.createdAt), asc(supplierPayments.id));

  const reversed = alias(defectMovements, "reversed_movement");
  const returnRows = await db
    .select({
      purchaseId: purchaseItems.purchaseId,
      id: defectMovements.id,
      type: defectMovements.type,
      reversesMovementId: defectMovements.reversesMovementId,
      occurredAt: defectMovements.occurredAt,
      createdAt: defectMovements.createdAt,
      valueAmount: defectMovements.valueAmount,
      itemName: lineItemName,
    })
    .from(defectMovements)
    .innerJoin(purchaseItems, eq(purchaseItems.id, defectMovements.purchaseItemId))
    .leftJoin(fabrics, eq(fabrics.id, purchaseItems.fabricId))
    .leftJoin(fabricColors, eq(fabricColors.id, purchaseItems.fabricColorId))
    .leftJoin(accessories, eq(accessories.id, purchaseItems.accessoryId))
    .leftJoin(reversed, eq(reversed.id, defectMovements.reversesMovementId))
    .where(and(isNotNull(defectMovements.purchaseItemId), or(eq(defectMovements.type, "return_out"), and(eq(defectMovements.type, "reversal"), eq(reversed.type, "return_out")))))
    .orderBy(asc(defectMovements.createdAt), asc(defectMovements.id));

  const byId = new Map<string, PurchaseDocumentSnapshot>(documents.map((document) => [document.id, { ...document, receiptItems: [], payments: [], defectReturns: [] }]));
  for (const { purchaseId, acceptedValue, rejectValue, ...row } of receiptRows) {
    const document = purchaseId ? byId.get(purchaseId) : undefined;
    if (!document) continue;
    const item: PurchaseReceiptItemSnapshot = {
      ...row,
      kind: row.kind,
      acceptedValue: toNumber(acceptedValue),
      rejectValue: toNumber(rejectValue),
    };
    document.receiptItems.push(item);
  }
  for (const { purchaseId, ...row } of paymentRows) {
    const document = purchaseId ? byId.get(purchaseId) : undefined;
    if (document) document.payments.push(row satisfies PurchasePaymentSnapshot);
  }
  for (const { purchaseId, type, ...row } of returnRows) {
    const document = byId.get(purchaseId);
    if (!document || (type !== "return_out" && type !== "reversal")) continue;
    document.defectReturns.push({ ...row, type } satisfies PurchaseDefectReturnSnapshot);
  }
  return [...byId.values()];
}

/** Raw-material adjustments (P7) and legacy manual purchases (to flag any dated after the start). */
export async function loadRawMaterialMovementSnapshots(db: Database): Promise<RawMaterialMovementSnapshot[]> {
  const fabricRows = await db
    .select({
      id: fabricStockMovements.id,
      fabricId: fabricStockMovements.fabricId,
      itemName: sql<string>`${fabrics.name} || coalesce(' ' || ${fabricColors.name}::text, '')`,
      type: fabricStockMovements.type,
      reason: fabricStockMovements.reason,
      qty: fabricStockMovements.qty,
      valueAmount: fabricStockMovements.valueAmount,
      createdAt: fabricStockMovements.createdAt,
      voidedAt: fabricStockMovements.voidedAt,
    })
    .from(fabricStockMovements)
    .innerJoin(fabrics, eq(fabrics.id, fabricStockMovements.fabricId))
    .leftJoin(fabricColors, eq(fabricColors.id, fabricStockMovements.fabricColorId))
    .where(or(eq(fabricStockMovements.type, "adjustment"), and(eq(fabricStockMovements.type, "purchase"), eq(fabricStockMovements.refType, "manual"))))
    .orderBy(asc(fabricStockMovements.createdAt), asc(fabricStockMovements.id));
  const accessoryRows = await db
    .select({
      id: accessoryMovements.id,
      accessoryId: accessoryMovements.accessoryId,
      itemName: accessories.name,
      type: accessoryMovements.type,
      reason: accessoryMovements.reason,
      qty: accessoryMovements.qty,
      valueAmount: accessoryMovements.valueAmount,
      createdAt: accessoryMovements.createdAt,
      voidedAt: accessoryMovements.voidedAt,
    })
    .from(accessoryMovements)
    .innerJoin(accessories, eq(accessories.id, accessoryMovements.accessoryId))
    .where(or(eq(accessoryMovements.type, "adjustment"), and(eq(accessoryMovements.type, "purchase"), eq(accessoryMovements.refType, "manual"))))
    .orderBy(asc(accessoryMovements.createdAt), asc(accessoryMovements.id));

  const rows = [
    ...fabricRows.map(({ fabricId, type, voidedAt, ...row }) => ({
      ...row,
      voided: voidedAt !== null,
      material: "fabric" as const,
      kind: type === "adjustment" ? ("adjustment" as const) : ("legacy_purchase" as const),
      qty: Number(row.qty),
      groupKey: fabricId,
    })),
    ...accessoryRows.map(({ accessoryId, type, voidedAt, ...row }) => ({
      ...row,
      voided: voidedAt !== null,
      itemName: String(row.itemName),
      material: "accessory" as const,
      kind: type === "adjustment" ? ("adjustment" as const) : ("legacy_purchase" as const),
      groupKey: accessoryId,
    })),
  ];
  return markReclassifications(rows).map(({ groupKey: _groupKey, ...row }) => row);
}
