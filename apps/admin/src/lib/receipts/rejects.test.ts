import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase, type TestTx } from "@ammari/db/test-utils";
import { insertAccessory, insertProductVariant, insertStaffUser, insertVariantForProduct } from "@ammari/db/test-fixtures";
import {
  defectMovements,
  fabrics,
  goodsReceiptItems,
  productionBatches,
  productionBatchItems,
  products,
  purchaseItems,
  purchases,
  suppliers,
} from "@ammari/db/schema";
import { getStorefrontProductBySlug } from "@ammari/db/storefront";
import { ActionError, FieldError } from "@/lib/errors";
import {
  getDefectBalance,
  getDefectQtyBySku,
  heldDefectValue,
  listDefectMovementsForBatch,
  listDefectMovementsForPurchase,
  listDefectStockMaterials,
  listDefectStockSkus,
  stripDefectMovementAmounts,
} from "@/lib/defects/queries";
import { getAccessoryBalance } from "@/lib/inventory/accessories";
import { getFabricBalance, recordFabricPurchase } from "@/lib/inventory/fabric-stock";
import { createOrder } from "@ammari/commerce/orders";
import { listOrderableVariants } from "@/lib/orders/queries";
import { createDraft, postBatch } from "@/lib/production/queries";
import { closePurchase, createPurchase, getPurchaseDocument } from "@/lib/purchases/queries";
import { currentBalanceForSkuLocked } from "@ammari/commerce/stock";
import { getSkuDetail, listProductSkusForCount, listStockOverview } from "@/lib/stock/queries";
import { closeBatchShort, getBatchReceiptSummary, listReceiptsForBatch, listUnreceivedBatchesForProduct, postGoodsReceiptForBatch } from "./production";
import { listReceiptsForPurchase, postGoodsReceiptForPurchase, reverseGoodsReceipt } from "./queries";

// docs/plans/suppliers-goods-receipt.md session S5: rejects at receipt, for both sources. Rejected
// units go to the defect ledger with their value — never to sellable stock, never into the
// sellable moving average or HPP — and settle quantity (qtySettled = accepted + rejected), so a
// fully-arrived-but-partly-defective line has nothing outstanding while its status stays
// partially_received.

async function insertSupplier(tx: TestDatabase) {
  const [supplier] = await tx.insert(suppliers).values({ name: `Supplier Cacat ${randomUUID().slice(0, 8)}` }).returning();
  if (!supplier) throw new Error("failed to insert supplier fixture");
  return supplier;
}

async function insertFabric(tx: TestDatabase) {
  const [fabric] = await tx.insert(fabrics).values({ name: `Katun Cacat ${randomUUID().slice(0, 8)}` }).returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");
  return fabric;
}

/** 10 yards of fabric for Rp 1.000.000 and 6 pcs of an accessory for Rp 60.000. */
async function purchaseFixture(tx: TestDatabase, { fabricTotal = 1_000_000, fabricQty = 10 } = {}) {
  const staff = await insertStaffUser(tx);
  const supplier = await insertSupplier(tx);
  const fabric = await insertFabric(tx);
  const accessory = await insertAccessory(tx);
  const purchase = await createPurchase(
    {
      supplierId: supplier.id,
      orderedAt: "2026-10-01",
      lines: [
        { itemType: "fabric", itemId: fabric.id, qtyOrdered: fabricQty, totalAmount: fabricTotal },
        { itemType: "accessory", itemId: accessory.id, qtyOrdered: 6, totalAmount: 60_000 },
      ],
    },
    staff.id,
    tx,
  );
  const lines = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchase.id));
  return {
    staff,
    fabric,
    accessory,
    purchase,
    fabricLine: lines.find((line) => line.fabricId === fabric.id)!,
    accessoryLine: lines.find((line) => line.accessoryId === accessory.id)!,
  };
}

type PurchaseReceiptLine = { purchaseItemId: string; qtyAccepted: number; qtyRejected?: number };

function receivePurchase(tx: TestDatabase, purchaseId: string, actorId: string, lines: PurchaseReceiptLine[]) {
  return postGoodsReceiptForPurchase({ purchaseId, receivedAt: "2026-10-05", lines }, actorId, tx);
}

async function purchaseStatusOf(tx: TestDatabase, purchaseId: string) {
  const [row] = await tx.select({ status: purchases.status }).from(purchases).where(eq(purchases.id, purchaseId));
  return row?.status;
}

/** Posted batch, two lines: 3 pcs of SKU A and 2 pcs of SKU B, HPP/pcs Rp 200.000 (same as S4's). */
async function postedBatch(tx: TestDatabase) {
  const staff = await insertStaffUser(tx);
  const { fabric, color, product: productA, variant: variantA } = await insertProductVariant(tx);
  const { product: productB, variant: variantB } = await insertVariantForProduct(tx, fabric.id, color.id, {}, "L");
  await recordFabricPurchase({ fabricId: fabric.id, qty: 10, totalAmountPaid: 1_000_000, purchasedAt: "2026-09-01" }, null, tx);
  const draft = await createDraft(
    {
      fabricId: fabric.id,
      producedAt: "2026-10-01",
      fabricYards: 10,
      lines: [
        { sku: variantA.sku, qty: 3 },
        { sku: variantB.sku, qty: 2 },
      ],
    },
    null,
    tx,
  );
  await postBatch(draft.id, staff.id, tx);
  const lines = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, draft.id));
  return {
    staff,
    batch: draft,
    productA,
    productB,
    variantA,
    variantB,
    lineA: lines.find((line) => line.sku === variantA.sku)!,
    lineB: lines.find((line) => line.sku === variantB.sku)!,
  };
}

type BatchReceiptLine = { productionBatchItemId: string; qtyAccepted: number; qtyRejected?: number };

function receiveBatch(tx: TestDatabase, batchId: string, actorId: string, lines: BatchReceiptLine[]) {
  return postGoodsReceiptForBatch({ batchId, receivedAt: "2026-10-05", lines }, actorId, tx);
}

async function batchStatusOf(tx: TestDatabase, batchId: string) {
  const [row] = await tx.select({ receiptStatus: productionBatches.receiptStatus }).from(productionBatches).where(eq(productionBatches.id, batchId));
  return row?.receiptStatus;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected promise to reject, but it resolved");
}

const sellableSku = (tx: TestTx, sku: string) => currentBalanceForSkuLocked(tx, sku);

describe("purchase receipt with rejects", () => {
  test("8 good + 2 defective of 10 yards: sellable gets 8 at its slice, defect stock gets 2 with the rest; nothing outstanding; partially_received", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, fabricLine } = await purchaseFixture(tx);
      const { status } = await receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 8, qtyRejected: 2 }]);

      expect(status).toBe("partially_received");
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 8, valueAmount: 800_000 });
      expect(await getDefectBalance({ kind: "fabric", fabricId: fabric.id }, tx)).toEqual({ qty: 2, valueAmount: 200_000 });

      const document = await getPurchaseDocument(purchase.id, tx);
      const line = document!.lines.find((candidate) => candidate.id === fabricLine.id)!;
      expect(line).toMatchObject({ accepted: 8, rejected: 2, outstanding: 0 });

      // A fully-arrived-but-partly-defective line blocks further receipts (D16/D17).
      const error = await rejection(receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 1 }]));
      expect(error).toBeInstanceOf(FieldError);
      expect(error.message).toContain("sudah diterima lengkap");
    });
  });

  test("the 1:1 qty_rejected ⇔ reject-movement invariant: one 'reject' row per receipt line, naming the line and its receipt item", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, fabricLine, accessoryLine } = await purchaseFixture(tx);
      await receivePurchase(tx, purchase.id, staff.id, [
        { purchaseItemId: fabricLine.id, qtyAccepted: 7.5, qtyRejected: 0.25 },
        { purchaseItemId: accessoryLine.id, qtyAccepted: 6 },
      ]);
      const items = await tx.select().from(goodsReceiptItems).where(eq(goodsReceiptItems.purchaseItemId, fabricLine.id));
      expect(items.map((item) => [item.qtyAccepted, item.qtyRejected])).toEqual([[7.5, 0.25]]);
      const rows = await tx.select().from(defectMovements).where(eq(defectMovements.purchaseItemId, fabricLine.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: "reject", itemKind: "fabric", fabricId: fabric.id, qty: 0.25, goodsReceiptItemId: items[0]!.id, occurredAt: "2026-10-05" });
      // The accessory line rejected nothing: no defect row for it at all.
      expect(await tx.select().from(defectMovements).where(eq(defectMovements.purchaseItemId, accessoryLine.id))).toHaveLength(0);
    });
  });

  test("a reject never touches the sellable balance or the sellable moving average", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, fabricLine } = await purchaseFixture(tx);
      // Existing sellable stock at a different price: 10 yards for Rp 500.000 (avg 50.000).
      await recordFabricPurchase({ fabricId: fabric.id, qty: 10, totalAmountPaid: 500_000, purchasedAt: "2026-09-01" }, null, tx);
      await receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 6, qtyRejected: 4 }]);
      // Sellable: 10 old + 6 new at 100.000 = 16 yards, Rp 1.100.000. The 4 rejects (Rp 400.000) are
      // NOT in it, so the average feeding the next batch's HPP is 68.750, not polluted to 75.000.
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 16, valueAmount: 1_100_000 });
      expect(await getDefectBalance({ kind: "fabric", fabricId: fabric.id }, tx)).toEqual({ qty: 4, valueAmount: 400_000 });
    });
  });

  test("a line may accept 0 and reject some: no sellable row, whole slice to defect stock", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, accessory, accessoryLine } = await purchaseFixture(tx);
      await receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: accessoryLine.id, qtyAccepted: 0, qtyRejected: 2 }]);
      expect(await getAccessoryBalance(accessory.id, tx)).toEqual({ qty: 0, valueAmount: 0 });
      expect(await getDefectBalance({ kind: "accessory", accessoryId: accessory.id }, tx)).toEqual({ qty: 2, valueAmount: 20_000 });
      expect(await purchaseStatusOf(tx, purchase.id)).toBe("partially_received");
    });
  });

  test("over-receipt counts accepted AND rejected together (D17): refused entirely, nothing written", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, fabricLine } = await purchaseFixture(tx);
      await receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 5 }]);
      const error = await rejection(receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 4, qtyRejected: 2 }]));
      expect(error).toBeInstanceOf(FieldError);
      expect(error.message).toContain("melebihi sisa pesanan");
      expect(error.message).toContain("5.00 yard");
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 5, valueAmount: 500_000 });
      expect(await getDefectBalance({ kind: "fabric", fabricId: fabric.id }, tx)).toEqual({ qty: 0, valueAmount: 0 });
      // Exactly the remainder is fine.
      await receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 3, qtyRejected: 2 }]);
    });
  });

  test("refuses fractional accessory rejects and negative rejects", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine, accessoryLine } = await purchaseFixture(tx);
      await expect(receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: accessoryLine.id, qtyAccepted: 1, qtyRejected: 0.5 }])).rejects.toThrow("bilangan bulat");
      await expect(receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 1, qtyRejected: -1 }])).rejects.toThrow("tidak valid");
    });
  });

  test("slices with rejects across several partial receipts sum to EXACTLY total_amount (sellable + defect), no stranded rupiah", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, fabricLine } = await purchaseFixture(tx, { fabricTotal: 1_000_003, fabricQty: 9.99 });
      for (const [qtyAccepted, qtyRejected] of [
        [3.33, 0.5],
        [2, 1.16],
        [1, 2],
      ] as const) {
        await receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted, qtyRejected }]);
      }
      const sellable = await getFabricBalance(fabric.id, tx);
      const defect = await getDefectBalance({ kind: "fabric", fabricId: fabric.id }, tx);
      expect(sellable.qty).toBe(6.33);
      expect(defect.qty).toBe(3.66);
      expect(sellable.valueAmount + defect.valueAmount).toBe(1_000_003);
      expect(sellable.valueAmount).toBeGreaterThan(0);
      expect(defect.valueAmount).toBeGreaterThan(0);
    });
  });

  test("closing a document where only defective units arrived is 'closed', not 'cancelled' (D19)", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, accessoryLine } = await purchaseFixture(tx);
      await receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: accessoryLine.id, qtyAccepted: 0, qtyRejected: 1 }]);
      const closed = await closePurchase(purchase.id, "Pemasok tidak kirim lagi", staff.id, tx);
      expect(closed.status).toBe("closed");
    });
  });

  test("reversal reverses the defect rows too: exact negation, originals stamped, balances back to zero, status back to ordered", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, accessory, fabricLine, accessoryLine } = await purchaseFixture(tx);
      const { receipt } = await receivePurchase(tx, purchase.id, staff.id, [
        { purchaseItemId: fabricLine.id, qtyAccepted: 8, qtyRejected: 2 },
        { purchaseItemId: accessoryLine.id, qtyAccepted: 0, qtyRejected: 3 },
      ]);
      const { reversal, status } = await reverseGoodsReceipt(receipt.id, staff.id, tx);
      expect(status).toBe("ordered");

      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 0, valueAmount: 0 });
      expect(await getDefectBalance({ kind: "fabric", fabricId: fabric.id }, tx)).toEqual({ qty: 0, valueAmount: 0 });
      expect(await getDefectBalance({ kind: "accessory", accessoryId: accessory.id }, tx)).toEqual({ qty: 0, valueAmount: 0 });

      const reversalItems = await tx.select().from(goodsReceiptItems).where(eq(goodsReceiptItems.goodsReceiptId, reversal.id));
      expect(reversalItems.map((item) => [item.qtyAccepted + 0, item.qtyRejected]).sort()).toEqual([
        [-8, -2],
        [0, -3],
      ].sort());
      const rows = await tx.select().from(defectMovements).where(eq(defectMovements.purchaseItemId, fabricLine.id));
      const original = rows.find((row) => row.type === "reject")!;
      const negation = rows.find((row) => row.type === "reversal")!;
      expect(original.reversedAt).not.toBeNull();
      expect(negation).toMatchObject({ qty: -2, valueAmount: -200_000, reversesMovementId: original.id, fabricId: fabric.id });
      expect(reversalItems.map((item) => item.id)).toContain(negation.goodsReceiptItemId);

      // The line is free again: the full 10 can be received, valued at the full total.
      await receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 10 }]);
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 10, valueAmount: 1_000_000 });
      // Double reversal still refused.
      await expect(reverseGoodsReceipt(receipt.id, staff.id, tx)).rejects.toThrow("sudah dibatalkan");
    });
  });

  test("reversing an OLDER receipt while a later reject-bearing receipt stands keeps the line exact: a final arrival brings sellable + defect value to exactly total_amount", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, fabricLine } = await purchaseFixture(tx, { fabricTotal: 1_000_001, fabricQty: 3 });
      const { receipt: first } = await receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 1 }]);
      await receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 0.5, qtyRejected: 0.5 }]);
      await reverseGoodsReceipt(first.id, staff.id, tx);
      // 1 settled (0.5 good + 0.5 defective); the remaining 2 arrive.
      expect((await getPurchaseDocument(purchase.id, tx))!.lines.find((line) => line.id === fabricLine.id)!.outstanding).toBe(2);
      await receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 1.5, qtyRejected: 0.5 }]);
      const sellable = await getFabricBalance(fabric.id, tx);
      const defect = await getDefectBalance({ kind: "fabric", fabricId: fabric.id }, tx);
      expect([sellable.qty, defect.qty]).toEqual([2, 1]);
      expect(sellable.valueAmount + defect.valueAmount).toBe(1_000_001);
    });
  });

  test("reversal is refused once the receipt's defects were returned or released (S6 writes those; simulated here)", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, fabricLine } = await purchaseFixture(tx);
      const { receipt } = await receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 8, qtyRejected: 2 }]);
      await tx.insert(defectMovements).values({
        itemKind: "fabric",
        fabricId: fabric.id,
        purchaseItemId: fabricLine.id,
        type: "dispose",
        qty: -1,
        valueAmount: -100_000,
        disposalType: "discarded",
        proceedsAmount: 0,
        occurredAt: "2026-10-06",
        note: "Robek, dibuang",
        createdByStaffUserId: staff.id,
      });
      const error = await rejection(reverseGoodsReceipt(receipt.id, staff.id, tx));
      expect(error).toBeInstanceOf(ActionError);
      expect(error.message).toContain("Batalkan pengembalian atau pelepasan dulu");
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 8, valueAmount: 800_000 });
    });
  });

  test("document reads: receipt history carries rejects, defect history lists the reject, value stripped without finance.view_profit", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await purchaseFixture(tx);
      await receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 8, qtyRejected: 2 }]);
      const [receipt] = await listReceiptsForPurchase(purchase.id, tx);
      expect(receipt!.items).toEqual([expect.objectContaining({ qtyAccepted: 8, qtyRejected: 2 })]);

      const history = await listDefectMovementsForPurchase(purchase.id, tx);
      expect(history).toEqual([expect.objectContaining({ type: "reject", qty: 2, valueAmount: 200_000, receiptNo: receipt!.receiptNo })]);
      expect(heldDefectValue(history)).toBe(200_000);
      const stripped = stripDefectMovementAmounts(history, false);
      expect(stripped[0]!.valueAmount).toBeNull();
      expect(stripped[0]!.qty).toBe(2);
      expect(heldDefectValue(stripped)).toBeNull();
    });
  });

  test("defect rows are immutable: no edit, no delete", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await purchaseFixture(tx);
      await receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 8, qtyRejected: 2 }]);
      await expect(tx.update(defectMovements).set({ qty: 1 }).where(eq(defectMovements.purchaseItemId, fabricLine.id))).rejects.toThrow();
    });
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await purchaseFixture(tx);
      await receivePurchase(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 8, qtyRejected: 2 }]);
      await expect(tx.delete(defectMovements).where(eq(defectMovements.purchaseItemId, fabricLine.id))).rejects.toThrow();
    });
  });
});

describe("production receipt with rejects", () => {
  test("2 good + 1 defective of 3: sellable 2 and defect 1, both at the frozen HPP; HPP untouched; nothing outstanding; partially_received", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantA, lineA } = await postedBatch(tx);
      const { status } = await receiveBatch(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 2, qtyRejected: 1 }]);
      expect(status).toBe("partially_received");
      expect(await sellableSku(tx, variantA.sku)).toEqual({ qty: 2, valueAmount: 400_000 });
      expect(await getDefectBalance({ kind: "sku", sku: variantA.sku }, tx)).toEqual({ qty: 1, valueAmount: 200_000 });
      const [line] = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.id, lineA.id));
      expect(line!.unitCostAmount).toBe(lineA.unitCostAmount);

      const summary = await getBatchReceiptSummary(batch.id, tx);
      expect(summary!.lines.find((candidate) => candidate.id === lineA.id)).toMatchObject({ planned: 3, received: 2, rejected: 1, outstanding: 0 });
      const error = await rejection(receiveBatch(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 1 }]));
      expect(error.message).toContain("sudah diterima lengkap");
    });
  });

  test("the reject row mirrors qty_rejected 1:1 and names the batch line; over-receipt counts accepted and rejected together", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantB, lineB } = await postedBatch(tx);
      const error = await rejection(receiveBatch(tx, batch.id, staff.id, [{ productionBatchItemId: lineB.id, qtyAccepted: 2, qtyRejected: 1 }]));
      expect(error).toBeInstanceOf(FieldError);
      expect(error.message).toContain("ditambah ditolak");
      expect(error.message).toContain("2 pcs");
      await expect(receiveBatch(tx, batch.id, staff.id, [{ productionBatchItemId: lineB.id, qtyAccepted: 1, qtyRejected: 0.5 }])).rejects.toThrow("bilangan bulat");

      const { receipt } = await receiveBatch(tx, batch.id, staff.id, [{ productionBatchItemId: lineB.id, qtyAccepted: 0, qtyRejected: 2 }]);
      const [item] = await tx.select().from(goodsReceiptItems).where(eq(goodsReceiptItems.goodsReceiptId, receipt.id));
      const rows = await tx.select().from(defectMovements).where(eq(defectMovements.productionBatchItemId, lineB.id));
      expect(rows).toEqual([expect.objectContaining({ type: "reject", itemKind: "sku", sku: variantB.sku, qty: 2, valueAmount: 400_000, goodsReceiptItemId: item!.id })]);
      expect(await sellableSku(tx, variantB.sku)).toEqual({ qty: 0, valueAmount: 0 });

      const [history] = await listReceiptsForBatch(batch.id, tx);
      expect(history!.items).toEqual([expect.objectContaining({ qtyAccepted: 0, qtyRejected: 2 })]);
      expect(await listDefectMovementsForBatch(batch.id, tx)).toEqual([expect.objectContaining({ qty: 2, receiptNo: receipt.receiptNo })]);
    });
  });

  test("reversal reverses the defect rows too, and the batch is pending again", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantA, variantB, lineA, lineB } = await postedBatch(tx);
      const { receipt } = await receiveBatch(tx, batch.id, staff.id, [
        { productionBatchItemId: lineA.id, qtyAccepted: 2, qtyRejected: 1 },
        { productionBatchItemId: lineB.id, qtyAccepted: 0, qtyRejected: 2 },
      ]);
      const { status } = await reverseGoodsReceipt(receipt.id, staff.id, tx);
      expect(status).toBe("pending");
      expect(await sellableSku(tx, variantA.sku)).toEqual({ qty: 0, valueAmount: 0 });
      expect(await getDefectBalance({ kind: "sku", sku: variantA.sku }, tx)).toEqual({ qty: 0, valueAmount: 0 });
      expect(await getDefectBalance({ kind: "sku", sku: variantB.sku }, tx)).toEqual({ qty: 0, valueAmount: 0 });
      const reversals = await tx.select().from(defectMovements).where(and(eq(defectMovements.type, "reversal"), eq(defectMovements.sku, variantB.sku)));
      expect(reversals).toEqual([expect.objectContaining({ qty: -2, valueAmount: -400_000, productionBatchItemId: lineB.id })]);
    });
  });

  test("a fully settled line (with rejects) is no stock-count trap, and short-closing it leaves no unabsorbed value", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, productA, lineA, lineB } = await postedBatch(tx);
      await receiveBatch(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 2, qtyRejected: 1 }]);
      expect(await listUnreceivedBatchesForProduct(productA.id, tx)).toEqual([]);
      await receiveBatch(tx, batch.id, staff.id, [{ productionBatchItemId: lineB.id, qtyAccepted: 2 }]);
      // Everything arrived but one unit was defective: still partially_received, closable.
      expect(await batchStatusOf(tx, batch.id)).toBe("partially_received");
      await closeBatchShort(batch.id, "Yang cacat tidak bisa diperbaiki", staff.id, tx);
      const summary = await getBatchReceiptSummary(batch.id, tx);
      expect(summary!.receiptStatus).toBe("closed");
      expect(summary!.lines.every((line) => line.outstanding === 0)).toBe(true);
    });
  });
});

describe("defect stock is invisible to every sellable, order, packing and storefront path (D14)", () => {
  test("a SKU cannot be ordered, counted or shown as available against its defect quantity", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, productA, productB, variantA, variantB, lineA, lineB } = await postedBatch(tx);
      await tx.update(products).set({ isPublishedOnStorefront: true }).where(eq(products.id, productB.id));
      await receiveBatch(tx, batch.id, staff.id, [
        { productionBatchItemId: lineA.id, qtyAccepted: 1, qtyRejected: 2 },
        { productionBatchItemId: lineB.id, qtyAccepted: 0, qtyRejected: 2 },
      ]);

      // Orders: only the 1 accepted unit of A is sellable; B has none at all.
      const order = (sku: string, qty: number) =>
        createOrder(
          { channelId: "whatsapp", orderDate: "2026-10-06", items: [{ sku, qty, unitPrice: 259_000 }], discountAmount: 0, shippingAmount: 0, status: "to_ship" },
          staff.id,
          tx,
        );
      await expect(order(variantA.sku, 2)).rejects.toThrow();
      await expect(order(variantB.sku, 1)).rejects.toThrow();

      // Stock pages and the stock count read sellable stock only.
      const counted = await listProductSkusForCount(productA.id, tx);
      expect(counted.find((row) => row.sku === variantA.sku)?.currentStock).toBe(1);
      const overview = await listStockOverview({ q: variantB.sku }, undefined, undefined, tx);
      expect(overview.rows.find((row) => row.sku === variantB.sku)?.currentStock).toBe(0);
      expect((await getSkuDetail(variantB.sku, tx))?.currentStock).toBe(0);
      expect((await listOrderableVariants(tx)).some((row) => row.sku === variantB.sku)).toBe(true); // listed, never with stock

      // Storefront: B has only defects, so it is not available.
      const storefront = await getStorefrontProductBySlug(productB.slug, tx);
      expect(storefront?.variants.find((variant) => variant.sku === variantB.sku)?.available).toBe(false);

      // ...while the deliberate defect readers do see them.
      expect(await getDefectQtyBySku([variantA.sku, variantB.sku], tx)).toEqual(new Map([[variantA.sku, 2], [variantB.sku, 2]]));
      const defectSkus = await listDefectStockSkus(tx);
      const listed = defectSkus.filter((row) => row.sku === variantA.sku || row.sku === variantB.sku).map((row) => [row.sku, row.qty, row.valueAmount]);
      expect(listed).toHaveLength(2);
      expect(listed).toEqual(
        expect.arrayContaining([
          [variantA.sku, 2, 400_000],
          [variantB.sku, 2, 400_000],
        ]),
      );
      // Once 1 accepted unit is sold, A is out of sellable stock even though 2 defects remain.
      await order(variantA.sku, 1);
      await expect(order(variantA.sku, 1)).rejects.toThrow();
      expect((await getDefectBalance({ kind: "sku", sku: variantA.sku }, tx)).qty).toBe(2);
    });
  });

  test("raw-material defects appear only in the defect listing, never in the sellable balance", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, accessory, fabricLine, accessoryLine } = await purchaseFixture(tx);
      await receivePurchase(tx, purchase.id, staff.id, [
        { purchaseItemId: fabricLine.id, qtyAccepted: 0, qtyRejected: 1.5 },
        { purchaseItemId: accessoryLine.id, qtyAccepted: 0, qtyRejected: 1 },
      ]);
      expect((await getFabricBalance(fabric.id, tx)).qty).toBe(0);
      expect((await getAccessoryBalance(accessory.id, tx)).qty).toBe(0);
      const materials = await listDefectStockMaterials(tx);
      expect(materials.filter((row) => row.id === fabric.id || row.id === accessory.id).map((row) => [row.kind, row.qty, row.valueAmount])).toEqual([
        ["fabric", 1.5, 150_000],
        ["accessory", 1, 10_000],
      ]);
    });
  });

  test("structural guard: no sellable, order, packing or storefront source file references the defect ledger", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "../../../../..");
    const roots = [
      "apps/admin/src/lib/orders",
      "apps/admin/src/lib/packing",
      "apps/admin/src/lib/stock",
      "apps/admin/src/lib/inventory",
      "packages/db/src/storefront",
      "apps/web/src",
    ].map((relative) => path.join(repoRoot, relative));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
      }
    };
    for (const root of roots) walk(root);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((file) => /defectMovements|defect_movements|lib\/defects/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
