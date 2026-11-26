import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accessories,
  accessoryMovements,
  defectMovements,
  fabricStockMovements,
  fabrics,
  goodsReceiptItems,
  goodsReceipts,
  privateFiles,
  purchaseItems,
  purchases,
  supplierPayments,
  suppliers,
  type StockAdjustmentReason,
} from "@ammari/db/schema";
import type { TestTx } from "@ammari/db/test-utils";

// Fixture rows for the Session 7 DB tests, written the way the app writes them (lib/receipts,
// lib/defects, lib/inventory in apps/admin): a receipt item plus its raw-ledger row and reject row,
// a reversal receipt negating it exactly, returns to the supplier, raw-material adjustments.

export interface PurchaseFixture {
  purchaseId: string;
  purchaseNo: string;
  supplierId: string;
  supplierName: string;
  fabricId: string;
  lineId: string;
  accessoryId: string;
  accessoryLineId: string;
  staffId: string;
}

export async function insertPurchaseFixture(tx: TestTx, staffId: string, total = 1_000_000): Promise<PurchaseFixture> {
  const suffix = randomUUID().slice(0, 8);
  const [supplier] = await tx.insert(suppliers).values({ name: `Uji Pemasok Kain ${suffix}` }).returning({ id: suppliers.id, name: suppliers.name });
  const [fabric] = await tx.insert(fabrics).values({ name: `Uji Katun ${suffix}` }).returning({ id: fabrics.id });
  const [accessory] = await tx.insert(accessories).values({ name: `Uji Kancing ${suffix}` }).returning({ id: accessories.id });
  const [purchase] = await tx
    .insert(purchases)
    .values({ purchaseNo: `PO-T-${suffix}`, supplierId: supplier!.id, orderedAt: "2026-12-01", createdByStaffUserId: staffId })
    .returning({ id: purchases.id, purchaseNo: purchases.purchaseNo });
  const [line] = await tx.insert(purchaseItems).values({ purchaseId: purchase!.id, itemType: "fabric", fabricId: fabric!.id, qtyOrdered: 20, totalAmount: total }).returning({ id: purchaseItems.id });
  const [accessoryLine] = await tx
    .insert(purchaseItems)
    .values({ purchaseId: purchase!.id, itemType: "accessory", accessoryId: accessory!.id, qtyOrdered: 100, totalAmount: 100_000 })
    .returning({ id: purchaseItems.id });
  return {
    purchaseId: purchase!.id,
    purchaseNo: purchase!.purchaseNo,
    supplierId: supplier!.id,
    supplierName: String(supplier!.name),
    fabricId: fabric!.id,
    lineId: line!.id,
    accessoryId: accessory!.id,
    accessoryLineId: accessoryLine!.id,
    staffId,
  };
}

export interface ReceiptInput {
  receivedAt: string;
  qtyAccepted?: number;
  acceptedValue?: number;
  qtyRejected?: number;
  rejectValue?: number;
  /** Receive the accessory line instead of the fabric line. */
  accessory?: boolean;
}

export interface ReceivedItem {
  receiptId: string;
  itemId: string;
  rawMovementId: string | null;
  rejectMovementId: string | null;
  input: Required<Omit<ReceiptInput, "accessory">> & { accessory: boolean };
}

export async function insertReceipt(tx: TestTx, fixture: PurchaseFixture, input: ReceiptInput): Promise<ReceivedItem> {
  const full = { qtyAccepted: 10, acceptedValue: 500_000, qtyRejected: 0, rejectValue: 0, accessory: false, ...input };
  const [receipt] = await tx
    .insert(goodsReceipts)
    .values({ receiptNo: `GR-T-${randomUUID().slice(0, 8)}`, sourceType: "purchase", purchaseId: fixture.purchaseId, kind: "receipt", receivedAt: full.receivedAt, createdByStaffUserId: fixture.staffId })
    .returning({ id: goodsReceipts.id });
  const lineId = full.accessory ? fixture.accessoryLineId : fixture.lineId;
  const [item] = await tx
    .insert(goodsReceiptItems)
    .values({ goodsReceiptId: receipt!.id, sourceType: "purchase", kind: "receipt", purchaseItemId: lineId, qtyAccepted: full.qtyAccepted, qtyRejected: full.qtyRejected })
    .returning({ id: goodsReceiptItems.id });
  let rawMovementId: string | null = null;
  if (full.qtyAccepted !== 0) {
    const common = {
      qty: full.qtyAccepted,
      valueAmount: full.acceptedValue,
      type: "purchase" as const,
      refType: "goods_receipt" as const,
      refId: item!.id,
      purchasedAt: full.receivedAt,
      supplierId: fixture.supplierId,
      supplier: fixture.supplierName,
      createdByStaffUserId: fixture.staffId,
    };
    const [raw] = full.accessory
      ? await tx.insert(accessoryMovements).values({ ...common, accessoryId: fixture.accessoryId }).returning({ id: accessoryMovements.id })
      : await tx.insert(fabricStockMovements).values({ ...common, fabricId: fixture.fabricId }).returning({ id: fabricStockMovements.id });
    rawMovementId = raw!.id;
  }
  let rejectMovementId: string | null = null;
  if (full.qtyRejected !== 0) {
    const [reject] = await tx
      .insert(defectMovements)
      .values({
        itemKind: full.accessory ? "accessory" : "fabric",
        ...(full.accessory ? { accessoryId: fixture.accessoryId } : { fabricId: fixture.fabricId }),
        type: "reject",
        qty: full.qtyRejected,
        valueAmount: full.rejectValue,
        goodsReceiptItemId: item!.id,
        purchaseItemId: lineId,
        occurredAt: full.receivedAt,
        createdByStaffUserId: fixture.staffId,
      })
      .returning({ id: defectMovements.id });
    rejectMovementId = reject!.id;
  }
  return { receiptId: receipt!.id, itemId: item!.id, rawMovementId, rejectMovementId, input: full };
}

/** "Batalkan penerimaan": a reversal receipt negating `original` exactly, as reverseGoodsReceipt does. */
export async function insertReceiptReversal(tx: TestTx, fixture: PurchaseFixture, original: ReceivedItem, receivedAt: string): Promise<string> {
  const now = new Date();
  await tx.update(goodsReceipts).set({ reversedAt: now, reversedByStaffUserId: fixture.staffId }).where(eq(goodsReceipts.id, original.receiptId));
  const [reversal] = await tx
    .insert(goodsReceipts)
    .values({
      receiptNo: `GR-T-${randomUUID().slice(0, 8)}`,
      sourceType: "purchase",
      purchaseId: fixture.purchaseId,
      kind: "reversal",
      receivedAt,
      reversesReceiptId: original.receiptId,
      createdByStaffUserId: fixture.staffId,
    })
    .returning({ id: goodsReceipts.id });
  const lineId = original.input.accessory ? fixture.accessoryLineId : fixture.lineId;
  const [item] = await tx
    .insert(goodsReceiptItems)
    .values({ goodsReceiptId: reversal!.id, sourceType: "purchase", kind: "reversal", purchaseItemId: lineId, qtyAccepted: -original.input.qtyAccepted, qtyRejected: -original.input.qtyRejected })
    .returning({ id: goodsReceiptItems.id });
  if (original.rawMovementId) {
    const common = {
      qty: -original.input.qtyAccepted,
      valueAmount: -original.input.acceptedValue,
      type: "purchase_void" as const,
      refType: "goods_receipt" as const,
      refId: item!.id,
      voidsMovementId: original.rawMovementId,
      supplierId: fixture.supplierId,
      createdByStaffUserId: fixture.staffId,
    };
    if (original.input.accessory) await tx.insert(accessoryMovements).values({ ...common, accessoryId: fixture.accessoryId });
    else await tx.insert(fabricStockMovements).values({ ...common, fabricId: fixture.fabricId });
  }
  if (original.rejectMovementId) {
    await tx.insert(defectMovements).values({
      itemKind: original.input.accessory ? "accessory" : "fabric",
      ...(original.input.accessory ? { accessoryId: fixture.accessoryId } : { fabricId: fixture.fabricId }),
      type: "reversal",
      qty: -original.input.qtyRejected,
      valueAmount: -original.input.rejectValue,
      goodsReceiptItemId: item!.id,
      purchaseItemId: lineId,
      occurredAt: receivedAt,
      reversesMovementId: original.rejectMovementId,
      createdByStaffUserId: fixture.staffId,
    });
  }
  return item!.id;
}

async function insertProof(tx: TestTx, staffId: string): Promise<string> {
  const fileId = randomUUID();
  const sha = fileId.replaceAll("-", "").padEnd(64, "0");
  await tx.insert(privateFiles).values({
    id: fileId,
    purpose: "payment_proof",
    storageKey: `test/payment_proof/${fileId}.jpg`,
    contentType: "image/jpeg",
    byteSize: 1,
    sha256: sha,
    originalFilename: "bukti.jpg",
    originalContentType: "image/jpeg",
    originalByteSize: 1,
    originalSha256: sha,
    uploadedByStaffUserId: staffId,
  });
  return fileId;
}

export async function insertPayment(
  tx: TestTx,
  fixture: PurchaseFixture,
  input: { paidAt: string; amount: number; method?: "cash" | "transfer"; voidedAt?: Date },
): Promise<string> {
  const [row] = await tx
    .insert(supplierPayments)
    .values({
      paymentNo: `BYR-T-${randomUUID().slice(0, 8)}`,
      targetType: "purchase",
      purchaseId: fixture.purchaseId,
      supplierId: fixture.supplierId,
      supplierName: fixture.supplierName,
      paidAt: input.paidAt,
      amount: input.amount,
      method: input.method ?? "transfer",
      proofFileId: await insertProof(tx, fixture.staffId),
      recordedByStaffUserId: fixture.staffId,
      ...(input.voidedAt ? { voidedAt: input.voidedAt, voidedByStaffUserId: fixture.staffId, voidReason: "Salah nominal" } : {}),
    })
    .returning({ id: supplierPayments.id });
  return row!.id;
}

/** A defect returned to the supplier (lib/defects/dispositions.ts recordReturnToSupplier). */
export async function insertReturnOut(tx: TestTx, fixture: PurchaseFixture, input: { occurredAt: string; qty: number; value: number }): Promise<string> {
  const [row] = await tx
    .insert(defectMovements)
    .values({
      itemKind: "fabric",
      fabricId: fixture.fabricId,
      type: "return_out",
      qty: -input.qty,
      valueAmount: -input.value,
      purchaseItemId: fixture.lineId,
      occurredAt: input.occurredAt,
      createdByStaffUserId: fixture.staffId,
    })
    .returning({ id: defectMovements.id });
  return row!.id;
}

export async function insertReturnReversal(tx: TestTx, fixture: PurchaseFixture, originalId: string, input: { occurredAt: string; qty: number; value: number }): Promise<string> {
  await tx.update(defectMovements).set({ reversedAt: new Date(), reversedByStaffUserId: fixture.staffId }).where(eq(defectMovements.id, originalId));
  const [row] = await tx
    .insert(defectMovements)
    .values({
      itemKind: "fabric",
      fabricId: fixture.fabricId,
      type: "reversal",
      qty: input.qty,
      valueAmount: input.value,
      purchaseItemId: fixture.lineId,
      occurredAt: input.occurredAt,
      reversesMovementId: originalId,
      createdByStaffUserId: fixture.staffId,
    })
    .returning({ id: defectMovements.id });
  return row!.id;
}

export async function closePurchase(tx: TestTx, fixture: PurchaseFixture, closedAt: Date, status: "closed" | "cancelled" = "closed"): Promise<void> {
  await tx.update(purchases).set({ status, closedAt, closedByStaffUserId: fixture.staffId, closeReason: "Tutup uji" }).where(eq(purchases.id, fixture.purchaseId));
}

export async function reopenPurchase(tx: TestTx, fixture: PurchaseFixture, reopenedAt: Date): Promise<void> {
  await tx
    .update(purchases)
    .set({ status: "partially_received", reopenedAt, reopenedByStaffUserId: fixture.staffId, reopenReason: "Retur ke pemasok" })
    .where(eq(purchases.id, fixture.purchaseId));
}

export async function insertFabricAdjustment(
  tx: TestTx,
  fixture: PurchaseFixture,
  input: { reason: StockAdjustmentReason; qty: number; value: number; createdAt?: Date; fabricColorId?: string | null },
): Promise<string> {
  const [row] = await tx
    .insert(fabricStockMovements)
    .values({
      fabricId: fixture.fabricId,
      fabricColorId: input.fabricColorId ?? null,
      qty: input.qty,
      valueAmount: input.value,
      type: "adjustment",
      refType: "manual",
      reason: input.reason,
      createdByStaffUserId: fixture.staffId,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning({ id: fabricStockMovements.id });
  return row!.id;
}
