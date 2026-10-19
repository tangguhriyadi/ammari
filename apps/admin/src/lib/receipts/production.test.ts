import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase, type TestTx } from "@ammari/db/test-utils";
import { insertProductVariant, insertStaffUser, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { auditLog, goodsReceipts, productionBatches, productionBatchItems, products, stockMovements } from "@ammari/db/schema";
import { getStorefrontProductBySlug } from "@ammari/db/storefront";
import { ActionError, FieldError } from "@/lib/errors";
import { getFabricBalance, recordFabricPurchase } from "@/lib/inventory/fabric-stock";
import { createOrder } from "@/lib/orders/queries";
import { createDraft, postBatch } from "@/lib/production/queries";
import { adjustStock, currentBalanceForSkuLocked, listStockLedger } from "@/lib/stock/queries";
import {
  closeBatchShort,
  effectiveReceiptStatuses,
  getBatchReceiptSummary,
  listReceiptsForBatch,
  listUnreceivedBatchesForProduct,
  postGoodsReceiptForBatch,
  unabsorbedValue,
} from "./production";
import { reverseGoodsReceipt } from "./queries";

// docs/plans/suppliers-goods-receipt.md session S4: posting a batch no longer adds finished-goods
// stock; output enters stock only through goods receipts against the batch.

/** A posted batch on one fabric with two lines: 3 pcs of SKU A (product A) and 2 pcs of SKU B
 * (product B). 10 yards bought for Rp 1.000.000, all consumed: HPP/pcs = ceil(1.000.000 / 5) =
 * Rp 200.000. */
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
  const lineA = lines.find((line) => line.sku === variantA.sku)!;
  const lineB = lines.find((line) => line.sku === variantB.sku)!;
  return { staff, fabric, color, batch: draft, productA, productB, variantA, variantB, lineA, lineB };
}

function receive(tx: TestDatabase, batchId: string, actorId: string, lines: { productionBatchItemId: string; qtyAccepted: number }[]) {
  return postGoodsReceiptForBatch({ batchId, receivedAt: "2026-10-05", lines }, actorId, tx);
}

async function receiptStatusOf(tx: TestDatabase, batchId: string) {
  const [row] = await tx.select({ receiptStatus: productionBatches.receiptStatus }).from(productionBatches).where(eq(productionBatches.id, batchId));
  return row?.receiptStatus;
}

/** Read inside the test's own transaction (the locked-balance helper needs a transaction). */
async function balanceOf(tx: TestTx, sku: string) {
  return currentBalanceForSkuLocked(tx, sku);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected promise to reject, but it resolved");
}

/** What a release before S4 left behind for a posted batch: one at-posting 'production' row per
 * line (ref_type 'production_batch_item'), and — after migration 0025's backfill — 'received'. */
async function makeLegacy(tx: TestDatabase, batchId: string, { backfilled }: { backfilled: boolean }) {
  const lines = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, batchId));
  await tx.insert(stockMovements).values(
    lines.map((line) => ({
      sku: line.sku,
      qty: line.qty,
      valueAmount: line.qty * line.unitCostAmount,
      type: "production",
      refType: "production_batch_item",
      refId: line.id,
    })),
  );
  if (backfilled) await tx.update(productionBatches).set({ receiptStatus: "received" }).where(eq(productionBatches.id, batchId));
}

describe("postBatch (S4)", () => {
  test("consumes material and freezes HPP, but writes NO finished-goods stock; receipt_status starts pending", async () => {
    await withRollback(async (tx) => {
      const { batch, fabric, variantA, variantB, lineA } = await postedBatch(tx);
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 0, valueAmount: 0 });
      expect(lineA.unitCostAmount).toBe(200_000);
      expect(await tx.select().from(stockMovements).where(eq(stockMovements.sku, variantA.sku))).toHaveLength(0);
      expect(await tx.select().from(stockMovements).where(eq(stockMovements.sku, variantB.sku))).toHaveLength(0);
      expect(await receiptStatusOf(tx, batch.id)).toBe("pending");
    });
  });
});

describe("postGoodsReceiptForBatch", () => {
  test("partial receipt per variant: stock rises by exactly the accepted pcs at the frozen HPP; partially_received; audit entry", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantA, variantB, lineA } = await postedBatch(tx);
      const { receipt, status } = await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 2 }]);
      expect(receipt.receiptNo).toMatch(/^GR-\d{6}-\d{3}$/);
      expect(receipt.sourceType).toBe("production_batch");
      expect(status).toBe("partially_received");
      expect(await receiptStatusOf(tx, batch.id)).toBe("partially_received");

      expect(await balanceOf(tx, variantA.sku)).toEqual({ qty: 2, valueAmount: 400_000 });
      expect(await balanceOf(tx, variantB.sku)).toEqual({ qty: 0, valueAmount: 0 });
      const [movement] = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variantA.sku));
      expect(movement).toMatchObject({ type: "production", refType: "goods_receipt_item", qty: 2, valueAmount: 400_000 });

      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "goods_receipt"), eq(auditLog.entityId, receipt.id)));
      expect(audits.map((row) => row.action)).toEqual(["receive"]);

      const summary = await getBatchReceiptSummary(batch.id, tx);
      expect(summary?.lines.map((line) => [line.sku, line.planned, line.received, line.outstanding])).toEqual(
        expect.arrayContaining([
          [variantA.sku, 3, 2, 1],
          [variantB.sku, 2, 0, 2],
        ]),
      );
    });
  });

  test("multiple receipts complete the batch: received, and total value = planned pcs × HPP", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantA, variantB, lineA, lineB } = await postedBatch(tx);
      await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 1 }]);
      await receive(tx, batch.id, staff.id, [
        { productionBatchItemId: lineA.id, qtyAccepted: 1 },
        { productionBatchItemId: lineB.id, qtyAccepted: 1 },
      ]);
      const { status } = await receive(tx, batch.id, staff.id, [
        { productionBatchItemId: lineA.id, qtyAccepted: 1 },
        { productionBatchItemId: lineB.id, qtyAccepted: 1 },
      ]);
      expect(status).toBe("received");
      expect(await balanceOf(tx, variantA.sku)).toEqual({ qty: 3, valueAmount: 600_000 });
      expect(await balanceOf(tx, variantB.sku)).toEqual({ qty: 2, valueAmount: 400_000 });
      expect(await listReceiptsForBatch(batch.id, tx)).toHaveLength(3);
    });
  });

  test("over-receipt is refused with an Indonesian message naming the line and what is left, and nothing moves", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, productA, variantA, lineA } = await postedBatch(tx);
      await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 2 }]);
      const error = await rejection(receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 2 }]));
      expect(error).toBeInstanceOf(FieldError);
      expect(error.message).toContain(productA.name);
      expect(error.message).toContain("melebihi sisa batch");
      expect(error.message).toContain("Sisa yang belum diterima: 1 pcs");
      expect((await balanceOf(tx, variantA.sku)).qty).toBe(2);
    });
  });

  test("refuses an all-zero receipt, a fractional quantity, a future date and a line from another batch", async () => {
    await withRollback(async (tx) => {
      const first = await postedBatch(tx);
      const second = await postedBatch(tx);
      await expect(receive(tx, first.batch.id, first.staff.id, [{ productionBatchItemId: first.lineA.id, qtyAccepted: 0 }])).rejects.toThrow("minimal");
      await expect(receive(tx, first.batch.id, first.staff.id, [{ productionBatchItemId: first.lineA.id, qtyAccepted: 1.5 }])).rejects.toThrow(
        "bilangan bulat",
      );
      await expect(
        postGoodsReceiptForBatch(
          { batchId: first.batch.id, receivedAt: "2999-01-01", lines: [{ productionBatchItemId: first.lineA.id, qtyAccepted: 1 }] },
          first.staff.id,
          tx,
        ),
      ).rejects.toThrow("masa depan");
      await expect(receive(tx, first.batch.id, first.staff.id, [{ productionBatchItemId: second.lineA.id, qtyAccepted: 1 }])).rejects.toThrow(
        "bukan bagian",
      );
    });
  });

  test("refuses a draft, a fully received and a closed batch", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, fabric, variantA, lineA, lineB } = await postedBatch(tx);
      const draft = await createDraft({ fabricId: fabric.id, producedAt: "2026-10-01", fabricYards: 1, lines: [{ sku: variantA.sku, qty: 1 }] }, null, tx);
      const [draftLine] = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, draft.id));
      await expect(receive(tx, draft.id, staff.id, [{ productionBatchItemId: draftLine!.id, qtyAccepted: 1 }])).rejects.toThrow("belum diposting");

      await receive(tx, batch.id, staff.id, [
        { productionBatchItemId: lineA.id, qtyAccepted: 3 },
        { productionBatchItemId: lineB.id, qtyAccepted: 2 },
      ]);
      await expect(receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 1 }])).rejects.toThrow("sudah diterima");

      const other = await postedBatch(tx);
      await closeBatchShort(other.batch.id, "Penjahit berhenti", other.staff.id, tx);
      await expect(receive(tx, other.batch.id, other.staff.id, [{ productionBatchItemId: other.lineA.id, qtyAccepted: 1 }])).rejects.toThrow(
        "sudah ditutup",
      );
    });
  });

  test("partially received output can be sold right away, and only up to what was received", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantA, lineA } = await postedBatch(tx);
      const order = (qty: number) =>
        createOrder(
          { channelId: "whatsapp", orderDate: "2026-10-06", items: [{ sku: variantA.sku, qty, unitPrice: 259_000 }], discountAmount: 0, shippingAmount: 0, status: "to_ship" },
          staff.id,
          tx,
        );
      await expect(order(1)).rejects.toThrow(); // nothing received yet: not in stock
      await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 2 }]);
      await order(2);
      expect((await balanceOf(tx, variantA.sku)).qty).toBe(0);
      await expect(order(1)).rejects.toThrow();
    });
  });
});

describe("closeBatchShort (Tutup batch)", () => {
  test("closes with reason and stamps, moves no stock, keeps HPP frozen, and reports the unabsorbed value", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantA, lineA, lineB } = await postedBatch(tx);
      await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 3 }]);
      const closed = await closeBatchShort(batch.id, "  Sisa kain rusak  ", staff.id, tx);
      expect(closed).toMatchObject({ receiptStatus: "closed", closeReason: "Sisa kain rusak", closedByStaffUserId: staff.id, status: "posted" });
      expect(closed.closedAt).not.toBeNull();
      expect(await balanceOf(tx, variantA.sku)).toEqual({ qty: 3, valueAmount: 600_000 });

      const [lineBAfter] = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.id, lineB.id));
      expect(lineBAfter?.unitCostAmount).toBe(200_000);
      const summary = await getBatchReceiptSummary(batch.id, tx);
      const lines = summary!.lines.map((line) => ({ outstanding: line.outstanding, unitCostAmount: 200_000 }));
      expect(unabsorbedValue(lines)).toBe(2 * 200_000);

      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "production_batch"), eq(auditLog.action, "close"), eq(auditLog.entityId, batch.id)));
      expect(audits).toHaveLength(1);
    });
  });

  test("a reason is required; a closed, fully received or draft batch cannot be closed", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, fabric, variantA, lineA, lineB } = await postedBatch(tx);
      await expect(closeBatchShort(batch.id, "  ", staff.id, tx)).rejects.toThrow("Alasan wajib diisi");
      await closeBatchShort(batch.id, "Batal jahit", staff.id, tx);
      await expect(closeBatchShort(batch.id, "Lagi", staff.id, tx)).rejects.toBeInstanceOf(ActionError);

      const done = await postedBatch(tx);
      await receive(tx, done.batch.id, done.staff.id, [
        { productionBatchItemId: done.lineA.id, qtyAccepted: 3 },
        { productionBatchItemId: done.lineB.id, qtyAccepted: 2 },
      ]);
      await expect(closeBatchShort(done.batch.id, "Tutup", done.staff.id, tx)).rejects.toThrow("sudah diterima lengkap");

      const draft = await createDraft({ fabricId: fabric.id, producedAt: "2026-10-01", fabricYards: 1, lines: [{ sku: variantA.sku, qty: 1 }] }, null, tx);
      await expect(closeBatchShort(draft.id, "Tutup", staff.id, tx)).rejects.toThrow("belum diposting");
      expect(lineA.id).not.toBe(lineB.id);
    });
  });
});

describe("reverseGoodsReceipt (production receipt)", () => {
  test("reverses exactly: stock and value back, status recomputed, reversal receipt recorded, audit entry", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantA, variantB, lineA, lineB } = await postedBatch(tx);
      await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 1 }]);
      const { receipt } = await receive(tx, batch.id, staff.id, [
        { productionBatchItemId: lineA.id, qtyAccepted: 2 },
        { productionBatchItemId: lineB.id, qtyAccepted: 2 },
      ]);
      expect(await receiptStatusOf(tx, batch.id)).toBe("received");

      const { reversal, status } = await reverseGoodsReceipt(receipt.id, staff.id, tx);
      expect(status).toBe("partially_received");
      expect(reversal).toMatchObject({ kind: "reversal", reversesReceiptId: receipt.id, sourceType: "production_batch" });
      expect(await balanceOf(tx, variantA.sku)).toEqual({ qty: 1, valueAmount: 200_000 });
      expect(await balanceOf(tx, variantB.sku)).toEqual({ qty: 0, valueAmount: 0 });

      const negations = await tx.select().from(stockMovements).where(and(eq(stockMovements.sku, variantB.sku), eq(stockMovements.refType, "goods_receipt_item")));
      expect(negations.map((row) => row.qty).sort()).toEqual([-2, 2]);

      const receipts = await listReceiptsForBatch(batch.id, tx);
      expect(receipts.find((row) => row.id === receipt.id)?.reversedAt).not.toBeNull();
      expect(receipts.find((row) => row.id === reversal.id)?.reversesReceiptNo).toBe(receipt.receiptNo);
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "goods_receipt"), eq(auditLog.action, "reverse"), eq(auditLog.entityId, receipt.id)));
      expect(audits).toHaveLength(1);

      // Re-receiving after the reversal completes the batch at exactly planned pcs × HPP.
      await receive(tx, batch.id, staff.id, [
        { productionBatchItemId: lineA.id, qtyAccepted: 2 },
        { productionBatchItemId: lineB.id, qtyAccepted: 2 },
      ]);
      expect(await balanceOf(tx, variantA.sku)).toEqual({ qty: 3, valueAmount: 600_000 });
      expect(await receiptStatusOf(tx, batch.id)).toBe("received");
    });
  });

  test("reversing the only receipt returns the batch to pending; on a closed batch it stays closed", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, lineA } = await postedBatch(tx);
      const { receipt } = await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 1 }]);
      expect((await reverseGoodsReceipt(receipt.id, staff.id, tx)).status).toBe("pending");

      const other = await postedBatch(tx);
      const { receipt: closedReceipt } = await receive(tx, other.batch.id, other.staff.id, [{ productionBatchItemId: other.lineA.id, qtyAccepted: 1 }]);
      await closeBatchShort(other.batch.id, "Tidak dilanjutkan", other.staff.id, tx);
      expect((await reverseGoodsReceipt(closedReceipt.id, other.staff.id, tx)).status).toBe("closed");
    });
  });

  test("a double reversal, and reversing a reversal, are refused", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, lineA } = await postedBatch(tx);
      const { receipt } = await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 1 }]);
      const { reversal } = await reverseGoodsReceipt(receipt.id, staff.id, tx);
      await expect(reverseGoodsReceipt(receipt.id, staff.id, tx)).rejects.toThrow("sudah dibatalkan");
      await expect(reverseGoodsReceipt(reversal.id, staff.id, tx)).rejects.toBeInstanceOf(ActionError);
    });
  });

  test("refused once those units were sold (an order, packed or not, always has its sale row)", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantA, lineA } = await postedBatch(tx);
      const { receipt } = await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 3 }]);
      await createOrder(
        { channelId: "whatsapp", orderDate: "2026-10-06", items: [{ sku: variantA.sku, qty: 1, unitPrice: 259_000 }], discountAmount: 0, shippingAmount: 0, status: "to_ship" },
        staff.id,
        tx,
      );
      await expect(reverseGoodsReceipt(receipt.id, staff.id, tx)).rejects.toThrow("sudah terjual atau disesuaikan");
      expect((await balanceOf(tx, variantA.sku)).qty).toBe(2);
    });
  });

  test("refused once those units were adjusted or counted, but not by activity on an unrelated SKU", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantA, variantB, lineA, lineB } = await postedBatch(tx);
      const { receipt: receiptA } = await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 3 }]);
      const { receipt: receiptB } = await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineB.id, qtyAccepted: 2 }]);
      await adjustStock({ sku: variantA.sku, deltaQty: -1, reason: "damaged" }, staff.id, tx);
      await expect(reverseGoodsReceipt(receiptA.id, staff.id, tx)).rejects.toThrow("Sesuaikan stok");
      // Variant B was never touched after its own receipt: still reversible.
      await reverseGoodsReceipt(receiptB.id, staff.id, tx);
      expect((await balanceOf(tx, variantB.sku)).qty).toBe(0);
    });
  });
});

describe("legacy posted batches (before S4) are counted exactly once", () => {
  test("backfilled to received: stock stays as posted, nothing outstanding, no receipt possible", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantA, variantB, lineA, productA } = await postedBatch(tx);
      await makeLegacy(tx, batch.id, { backfilled: true });

      expect(await balanceOf(tx, variantA.sku)).toEqual({ qty: 3, valueAmount: 600_000 });
      expect(await balanceOf(tx, variantB.sku)).toEqual({ qty: 2, valueAmount: 400_000 });
      const summary = await getBatchReceiptSummary(batch.id, tx);
      expect(summary?.receiptStatus).toBe("received");
      expect(summary?.lines.every((line) => line.outstanding === 0 && line.received === line.planned)).toBe(true);
      await expect(receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 1 }])).rejects.toThrow("sudah diterima");
      expect(await listUnreceivedBatchesForProduct(productA.id, tx)).toEqual([]);
    });
  });

  test("posted by the previous release after the migration (still pending): its at-posting stock counts as received, so it cannot be received again", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantA, lineA, productA } = await postedBatch(tx);
      await makeLegacy(tx, batch.id, { backfilled: false });
      expect(await receiptStatusOf(tx, batch.id)).toBe("pending");

      // The batch page and the production list treat it as fully received (no "Terima hasil",
      // no "Tutup batch", no "Belum diterima" badge).
      expect((await getBatchReceiptSummary(batch.id, tx))?.receiptStatus).toBe("received");
      const [stored] = await tx.select().from(productionBatches).where(eq(productionBatches.id, batch.id));
      expect((await effectiveReceiptStatuses([stored!], tx)).get(batch.id)).toBe("received");
      const error = await rejection(receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 1 }]));
      expect(error.message).toContain("sudah diterima lengkap");
      expect((await balanceOf(tx, variantA.sku)).qty).toBe(3);
      expect(await listUnreceivedBatchesForProduct(productA.id, tx)).toEqual([]);
      await expect(closeBatchShort(batch.id, "Tutup", staff.id, tx)).rejects.toThrow("sudah diterima lengkap");
      const receiptCount = await tx.select().from(goodsReceipts).where(eq(goodsReceipts.productionBatchId, batch.id));
      expect(receiptCount).toHaveLength(0);
    });
  });
});

describe("listUnreceivedBatchesForProduct (stock-count guard)", () => {
  test("lists a posted batch while this product's output is outstanding, with the outstanding pcs, and drops it once received", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, productA, productB, lineA, lineB } = await postedBatch(tx);
      expect(await listUnreceivedBatchesForProduct(productA.id, tx)).toEqual([
        expect.objectContaining({ id: batch.id, batchNo: batch.batchNo, receiptStatus: "pending", outstandingPcs: 3 }),
      ]);

      await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 1 }]);
      expect(await listUnreceivedBatchesForProduct(productA.id, tx)).toEqual([
        expect.objectContaining({ id: batch.id, receiptStatus: "partially_received", outstandingPcs: 2 }),
      ]);

      // Product A fully in, product B still outstanding: no warning for A, a warning for B.
      await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 2 }]);
      expect(await listUnreceivedBatchesForProduct(productA.id, tx)).toEqual([]);
      expect(await listUnreceivedBatchesForProduct(productB.id, tx)).toHaveLength(1);

      await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineB.id, qtyAccepted: 2 }]);
      expect(await listUnreceivedBatchesForProduct(productB.id, tx)).toEqual([]);
    });
  });

  test("ignores drafts and short-closed batches", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, fabric, productA, variantA } = await postedBatch(tx);
      await closeBatchShort(batch.id, "Tidak dilanjutkan", staff.id, tx);
      await createDraft({ fabricId: fabric.id, producedAt: "2026-10-01", fabricYards: 1, lines: [{ sku: variantA.sku, qty: 1 }] }, null, tx);
      expect(await listUnreceivedBatchesForProduct(productA.id, tx)).toEqual([]);
    });
  });
});

describe("storefront availability", () => {
  test("a product is available only from received stock: not at posting, yes after a partial receipt, no again after its reversal", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, productA, variantA, lineA } = await postedBatch(tx);
      await tx.update(products).set({ isPublishedOnStorefront: true }).where(eq(products.id, productA.id));
      const availability = async () => (await getStorefrontProductBySlug(productA.slug, tx))?.variants.find((variant) => variant.sku === variantA.sku)?.available;

      expect(await availability()).toBe(false);
      const { receipt } = await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 1 }]);
      expect(await availability()).toBe(true);
      await reverseGoodsReceipt(receipt.id, staff.id, tx);
      expect(await availability()).toBe(false);
    });
  });
});

describe("listStockLedger links production rows back to their batch (S7)", () => {
  test("a receipt row, its reversal row and a legacy at-posting row all resolve to the batch; other rows link nowhere", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantA, lineA } = await postedBatch(tx);
      const { receipt } = await receive(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 2 }]);
      await reverseGoodsReceipt(receipt.id, staff.id, tx);
      await makeLegacy(tx, batch.id, { backfilled: false });
      await adjustStock({ sku: variantA.sku, deltaQty: -1, reason: "recount" }, staff.id, tx);

      const { rows } = await listStockLedger(variantA.sku, undefined, undefined, tx);
      const byRefType = (refType: string) => rows.filter((row) => row.refType === refType);
      expect(byRefType("goods_receipt_item")).toHaveLength(2);
      expect(byRefType("goods_receipt_item").every((row) => row.productionBatchId === batch.id)).toBe(true);
      expect(byRefType("production_batch_item").map((row) => row.productionBatchId)).toEqual([batch.id]);
      expect(rows.find((row) => row.type === "adjustment")?.productionBatchId).toBeNull();
    });
  });
});
