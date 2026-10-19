import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertAccessory, insertProductVariant, insertStaffUser, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { auditLog, defectMovements, fabrics, productionBatches, productionBatchItems, purchaseItems, purchases, suppliers } from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { getFabricBalance, recordFabricPurchase } from "@/lib/inventory/fabric-stock";
import { createDraft, postBatch } from "@/lib/production/queries";
import { closePurchase, createPurchase, getPurchaseDocument } from "@/lib/purchases/queries";
import { closeBatchShort, getBatchReceiptSummary, postGoodsReceiptForBatch } from "@/lib/receipts/production";
import { getSellableReceiptValueForPurchase, postGoodsReceiptForPurchase, reverseGoodsReceipt } from "@/lib/receipts/queries";
import { currentBalanceForSkuLocked } from "@/lib/stock/queries";
import { disposeDefects, returnDefectsToSupplier, reverseDefectMovement, validateDisposal } from "./dispositions";
import {
  getDefectBalance,
  getDefectQtyByAccessory,
  getDefectQtyByFabric,
  getDefectQtyBySku,
  listDefectMovementsForBatch,
  listDefectMovementsForPurchase,
  listItemDefectMovements,
  stripItemDefectAmounts,
} from "./queries";
import { batchVariance, divideRoundHalfUp, purchaseVariance, summarizeDefectValues } from "./variance";

// docs/plans/suppliers-goods-receipt.md session S6: returns to the supplier/tailor (re-opening
// exactly the room a replacement needs, and re-opening a closed document, D16/D18), releases
// (Lelang / Hibah / Dibuang, D24/D29) that never create outstanding, their copy-and-negate
// reversals (D8), and the §4.3 variance figures against hand-computed numbers.

const OCCURRED = "2026-10-06";

async function insertSupplier(tx: TestDatabase) {
  const [supplier] = await tx.insert(suppliers).values({ name: `Supplier S6 ${randomUUID().slice(0, 8)}` }).returning();
  return supplier!;
}

async function insertFabric(tx: TestDatabase) {
  const [fabric] = await tx.insert(fabrics).values({ name: `Katun S6 ${randomUUID().slice(0, 8)}` }).returning();
  return fabric!;
}

/** 10 yards of fabric for Rp 1.000.000 and 6 pcs of an accessory for Rp 60.000. */
async function purchaseFixture(tx: TestDatabase, { fabricId }: { fabricId?: string } = {}) {
  const staff = await insertStaffUser(tx);
  const supplier = await insertSupplier(tx);
  const fabric = fabricId ? { id: fabricId } : await insertFabric(tx);
  const accessory = await insertAccessory(tx);
  const purchase = await createPurchase(
    {
      supplierId: supplier.id,
      orderedAt: "2026-10-01",
      lines: [
        { itemType: "fabric", itemId: fabric.id, qtyOrdered: 10, totalAmount: 1_000_000 },
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

function receive(tx: TestDatabase, purchaseId: string, actorId: string, lines: { purchaseItemId: string; qtyAccepted: number; qtyRejected?: number }[]) {
  return postGoodsReceiptForPurchase({ purchaseId, receivedAt: "2026-10-05", lines }, actorId, tx);
}

async function purchaseRow(tx: TestDatabase, id: string) {
  const [row] = await tx.select().from(purchases).where(eq(purchases.id, id));
  return row!;
}

async function line(tx: TestDatabase, purchaseId: string, lineId: string) {
  return (await getPurchaseDocument(purchaseId, tx))!.lines.find((candidate) => candidate.id === lineId)!;
}

/** Posted batch: 3 pcs of SKU A and 2 pcs of SKU B, HPP/pcs Rp 200.000 (total cost Rp 1.000.000). */
async function postedBatch(tx: TestDatabase) {
  const staff = await insertStaffUser(tx);
  const { fabric, color, variant: variantA } = await insertProductVariant(tx);
  const { variant: variantB } = await insertVariantForProduct(tx, fabric.id, color.id, {}, "L");
  await recordFabricPurchase({ fabricId: fabric.id, qty: 10, totalAmountPaid: 1_000_000, purchasedAt: "2026-09-01" }, null, tx);
  const draft = await createDraft(
    { fabricId: fabric.id, producedAt: "2026-10-01", fabricYards: 10, lines: [{ sku: variantA.sku, qty: 3 }, { sku: variantB.sku, qty: 2 }] },
    null,
    tx,
  );
  await postBatch(draft.id, staff.id, tx);
  const lines = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, draft.id));
  return {
    staff,
    batch: draft,
    variantA,
    variantB,
    lineA: lines.find((row) => row.sku === variantA.sku)!,
    lineB: lines.find((row) => row.sku === variantB.sku)!,
  };
}

function receiveBatch(tx: TestDatabase, batchId: string, actorId: string, lines: { productionBatchItemId: string; qtyAccepted: number; qtyRejected?: number }[]) {
  return postGoodsReceiptForBatch({ batchId, receivedAt: "2026-10-05", lines }, actorId, tx);
}

async function batchRow(tx: TestDatabase, id: string) {
  const [row] = await tx.select().from(productionBatches).where(eq(productionBatches.id, id));
  return row!;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected promise to reject, but it resolved");
}

const fabricSource = (lineId: string) => ({ purchaseItemId: lineId });
const batchSource = (lineId: string) => ({ productionBatchItemId: lineId });

describe("return to supplier (D15/D16)", () => {
  test("§4.2 worked example end to end: 8 good + 2 defective → return 2 → outstanding exactly 2 → replacement of 2 → received, valued at exactly the total", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, fabricLine, accessoryLine } = await purchaseFixture(tx);
      await receive(tx, purchase.id, staff.id, [
        { purchaseItemId: fabricLine.id, qtyAccepted: 8, qtyRejected: 2 },
        { purchaseItemId: accessoryLine.id, qtyAccepted: 6 },
      ]);
      expect(await line(tx, purchase.id, fabricLine.id)).toMatchObject({ accepted: 8, rejected: 2, defectHeld: 2, outstanding: 0 });

      const { status, reopened } = await returnDefectsToSupplier({ source: fabricSource(fabricLine.id), qty: 2, reason: "Noda, tukar", occurredAt: OCCURRED }, staff.id, tx);
      expect(reopened).toBe(false);
      expect(status).toBe("partially_received");
      expect(await line(tx, purchase.id, fabricLine.id)).toMatchObject({ accepted: 8, rejected: 2, defectHeld: 0, returned: 2, released: 0, outstanding: 2 });
      // The returned units left defect stock with their value: the pool is exactly empty.
      expect(await getDefectBalance({ kind: "fabric", fabricId: fabric.id }, tx)).toEqual({ qty: 0, valueAmount: 0 });

      // The replacement is NOT over-receipt and completes the document.
      const { status: final } = await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 2 }]);
      expect(final).toBe("received");
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 10, valueAmount: 1_000_000 });
      // And nothing more fits.
      await expect(receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 0.01 }])).rejects.toThrow("sudah diterima");
    });
  });

  test("a return re-opens exactly its own quantity, and a replacement may itself arrive partly defective", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await purchaseFixture(tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 7, qtyRejected: 3 }]);
      await returnDefectsToSupplier({ source: fabricSource(fabricLine.id), qty: 1.5, reason: "Tukar", occurredAt: OCCURRED }, staff.id, tx);
      expect(await line(tx, purchase.id, fabricLine.id)).toMatchObject({ defectHeld: 1.5, returned: 1.5, outstanding: 1.5 });
      await expect(receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 1.51 }])).rejects.toThrow("1.50 yard");
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 1, qtyRejected: 0.5 }]);
      expect(await line(tx, purchase.id, fabricLine.id)).toMatchObject({ accepted: 8, rejected: 3.5, defectHeld: 2, outstanding: 0 });
    });
  });

  test("refused beyond what the line still holds, for fractional accessory pcs, and without a reason", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine, accessoryLine } = await purchaseFixture(tx);
      await receive(tx, purchase.id, staff.id, [
        { purchaseItemId: fabricLine.id, qtyAccepted: 8, qtyRejected: 2 },
        { purchaseItemId: accessoryLine.id, qtyAccepted: 4, qtyRejected: 2 },
      ]);
      const tooMuch = await rejection(returnDefectsToSupplier({ source: fabricSource(fabricLine.id), qty: 2.01, reason: "x", occurredAt: OCCURRED }, staff.id, tx));
      expect(tooMuch).toBeInstanceOf(FieldError);
      expect(tooMuch.message).toContain("Stok cacat tersedia: 2.00 yard");
      await expect(returnDefectsToSupplier({ source: fabricSource(accessoryLine.id), qty: 1.5, reason: "x", occurredAt: OCCURRED }, staff.id, tx)).rejects.toThrow("bilangan bulat");
      await expect(returnDefectsToSupplier({ source: fabricSource(fabricLine.id), qty: 1, reason: "  ", occurredAt: OCCURRED }, staff.id, tx)).rejects.toThrow("Alasan wajib diisi");
      await expect(returnDefectsToSupplier({ source: fabricSource(fabricLine.id), qty: 1, reason: "x", occurredAt: "2999-01-01" }, staff.id, tx)).rejects.toThrow("masa depan");
      // A release uses up held stock too: after releasing 1, only 1 can go back.
      await disposeDefects({ source: fabricSource(fabricLine.id), qty: 1, disposalType: "discarded", proceedsAmount: 0, note: "Robek", occurredAt: OCCURRED }, staff.id, tx);
      await expect(returnDefectsToSupplier({ source: fabricSource(fabricLine.id), qty: 2, reason: "x", occurredAt: OCCURRED }, staff.id, tx)).rejects.toThrow("1.00 yard");
    });
  });

  test("on a CLOSED purchase a return re-opens it: partially_received, reopen columns stamped, close record kept, audited", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await purchaseFixture(tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 8, qtyRejected: 2 }]);
      await closePurchase(purchase.id, "Cukup", staff.id, tx);
      expect((await purchaseRow(tx, purchase.id)).status).toBe("closed");
      // Closed: no receipt possible.
      await expect(receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 1 }])).rejects.toThrow("ditutup");

      const { status, reopened } = await returnDefectsToSupplier({ source: fabricSource(fabricLine.id), qty: 2, reason: "Supplier mau ganti", occurredAt: OCCURRED }, staff.id, tx);
      expect([status, reopened]).toEqual(["partially_received", true]);
      const row = await purchaseRow(tx, purchase.id);
      expect(row).toMatchObject({ status: "partially_received", reopenedByStaffUserId: staff.id, reopenReason: "Supplier mau ganti", closeReason: "Cukup" });
      expect(row.reopenedAt).not.toBeNull();
      expect(row.closedAt).not.toBeNull();
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, purchase.id), eq(auditLog.action, "reopen")));
      expect(audits).toHaveLength(1);
      expect((await getPurchaseDocument(purchase.id, tx))!.reopenReason).toBe("Supplier mau ganti");

      // The replacement arrives on the same document. The accessory line never came, so it stays
      // partially received until closed again.
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 2 }]);
      expect((await purchaseRow(tx, purchase.id)).status).toBe("partially_received");
      await closePurchase(purchase.id, "Aksesoris tidak dikirim", staff.id, tx);
      expect((await purchaseRow(tx, purchase.id)).status).toBe("closed");
    });
  });

  test("on a short-closed BATCH a return to the tailor re-opens it and the replacement completes it", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantA, lineA, lineB } = await postedBatch(tx);
      await receiveBatch(tx, batch.id, staff.id, [
        { productionBatchItemId: lineA.id, qtyAccepted: 2, qtyRejected: 1 },
        { productionBatchItemId: lineB.id, qtyAccepted: 2 },
      ]);
      await closeBatchShort(batch.id, "Selesai", staff.id, tx);
      const { status, reopened } = await returnDefectsToSupplier({ source: batchSource(lineA.id), qty: 1, reason: "Jahitan lepas, diperbaiki penjahit", occurredAt: OCCURRED }, staff.id, tx);
      expect([status, reopened]).toEqual(["partially_received", true]);
      expect(await batchRow(tx, batch.id)).toMatchObject({ receiptStatus: "partially_received", reopenReason: "Jahitan lepas, diperbaiki penjahit", closeReason: "Selesai" });
      const summary = await getBatchReceiptSummary(batch.id, tx);
      expect(summary!.lines.find((row) => row.id === lineA.id)).toMatchObject({ received: 2, rejected: 1, defectHeld: 0, returned: 1, outstanding: 1 });
      expect(summary!.reopenedAt).not.toBeNull();

      const { status: final } = await receiveBatch(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 1 }]);
      expect(final).toBe("received");
      // Replacement valued at the frozen HPP; HPP itself untouched.
      expect(await currentBalanceForSkuLocked(tx, variantA.sku)).toEqual({ qty: 3, valueAmount: 600_000 });
      expect(await getDefectBalance({ kind: "sku", sku: variantA.sku }, tx)).toEqual({ qty: 0, valueAmount: 0 });
    });
  });
});

describe("release (Pelepasan, D24/D29)", () => {
  test("validateDisposal: Lelang needs proceeds > 0; Hibah and Dibuang are exactly Rp 0", () => {
    expect(validateDisposal("auction", 50_000)).toBeNull();
    expect(validateDisposal("auction", 0)).toContain("Hasil lelang wajib");
    expect(validateDisposal("donation", 0)).toBeNull();
    expect(validateDisposal("discarded", 0)).toBeNull();
    expect(validateDisposal("donation", 1)).toContain("Rp 0");
    expect(validateDisposal("discarded", 1)).toContain("Rp 0");
    expect(validateDisposal("auction", 1.5)).toContain("tidak valid");
    expect(validateDisposal("auction", -1)).toContain("tidak valid");
  });

  test("each type is stored with its proceeds; none creates outstanding or changes the status; notes are required", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, fabricLine } = await purchaseFixture(tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 7, qtyRejected: 3 }]);
      const statusBefore = (await purchaseRow(tx, purchase.id)).status;

      await expect(
        disposeDefects({ source: fabricSource(fabricLine.id), qty: 1, disposalType: "auction", proceedsAmount: 0, note: "Lelang", occurredAt: OCCURRED }, staff.id, tx),
      ).rejects.toBeInstanceOf(FieldError);
      await expect(
        disposeDefects({ source: fabricSource(fabricLine.id), qty: 1, disposalType: "donation", proceedsAmount: 10_000, note: "Hibah", occurredAt: OCCURRED }, staff.id, tx),
      ).rejects.toThrow("Rp 0");
      await expect(
        disposeDefects({ source: fabricSource(fabricLine.id), qty: 1, disposalType: "discarded", proceedsAmount: 0, note: "   ", occurredAt: OCCURRED }, staff.id, tx),
      ).rejects.toThrow("Catatan wajib diisi");

      for (const [disposalType, proceedsAmount] of [
        ["auction", 40_000],
        ["donation", 0],
        ["discarded", 0],
      ] as const) {
        await disposeDefects({ source: fabricSource(fabricLine.id), qty: 1, disposalType, proceedsAmount, note: `Pelepasan ${disposalType}`, occurredAt: OCCURRED }, staff.id, tx);
        // Never outstanding: the line stays fully settled and the status unchanged.
        expect((await line(tx, purchase.id, fabricLine.id)).outstanding).toBe(0);
        expect((await purchaseRow(tx, purchase.id)).status).toBe(statusBefore);
      }
      const rows = await tx.select().from(defectMovements).where(and(eq(defectMovements.purchaseItemId, fabricLine.id), eq(defectMovements.type, "dispose")));
      expect(rows.map((row) => [row.disposalType, row.proceedsAmount, row.qty, row.valueAmount]).sort()).toEqual(
        [
          ["auction", 40_000, -1, -100_000],
          ["discarded", 0, -1, -100_000],
          ["donation", 0, -1, -100_000],
        ].sort(),
      );
      expect(await line(tx, purchase.id, fabricLine.id)).toMatchObject({ defectHeld: 0, released: 3, returned: 0 });
      // Defect pool empty, value exactly 0; sellable untouched.
      expect(await getDefectBalance({ kind: "fabric", fabricId: fabric.id }, tx)).toEqual({ qty: 0, valueAmount: 0 });
      expect(await getFabricBalance(fabric.id, tx)).toEqual({ qty: 7, valueAmount: 700_000 });
      // Nothing more to release.
      await expect(
        disposeDefects({ source: fabricSource(fabricLine.id), qty: 1, disposalType: "discarded", proceedsAmount: 0, note: "x", occurredAt: OCCURRED }, staff.id, tx),
      ).rejects.toThrow("Tidak ada stok cacat");
      // A release never re-opens a closed document either.
      await closePurchase(purchase.id, "Selesai", staff.id, tx);
      expect((await purchaseRow(tx, purchase.id)).status).toBe("closed");
    });
  });

  test("the pooled defect value is exactly 0 when its quantity reaches 0, even across documents at different prices", async () => {
    await withRollback(async (tx) => {
      const first = await purchaseFixture(tx);
      const second = await purchaseFixture(tx, { fabricId: first.fabric.id });
      // Make the second line's price awkward: 10 yards for Rp 1.000.003.
      await tx.update(purchaseItems).set({ totalAmount: 1_000_003, qtyOrdered: 9.99 }).where(eq(purchaseItems.id, second.fabricLine.id));
      await receive(tx, first.purchase.id, first.staff.id, [{ purchaseItemId: first.fabricLine.id, qtyAccepted: 9.67, qtyRejected: 0.33 }]);
      await receive(tx, second.purchase.id, first.staff.id, [{ purchaseItemId: second.fabricLine.id, qtyAccepted: 9.32, qtyRejected: 0.67 }]);
      const pool = { kind: "fabric" as const, fabricId: first.fabric.id };
      expect((await getDefectBalance(pool, tx)).qty).toBe(1);
      await disposeDefects({ source: fabricSource(second.fabricLine.id), qty: 0.29, disposalType: "auction", proceedsAmount: 7_000, note: "Lelang", occurredAt: OCCURRED }, first.staff.id, tx);
      await returnDefectsToSupplier({ source: fabricSource(first.fabricLine.id), qty: 0.33, reason: "Tukar", occurredAt: OCCURRED }, first.staff.id, tx);
      await disposeDefects({ source: fabricSource(second.fabricLine.id), qty: 0.38, disposalType: "donation", proceedsAmount: 0, note: "Hibah", occurredAt: OCCURRED }, first.staff.id, tx);
      expect(await getDefectBalance(pool, tx)).toEqual({ qty: 0, valueAmount: 0 });
    });
  });
});

describe("reversals (D8, copy-and-negate)", () => {
  test("reversing a return puts the units back in defect stock and removes the re-opened room; refused once the replacement arrived", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, fabricLine } = await purchaseFixture(tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 8, qtyRejected: 2 }]);
      const { movement } = await returnDefectsToSupplier({ source: fabricSource(fabricLine.id), qty: 2, reason: "Tukar", occurredAt: OCCURRED }, staff.id, tx);
      const { reversal } = await reverseDefectMovement(movement.id, staff.id, tx);
      expect(reversal).toMatchObject({ type: "reversal", qty: 2, valueAmount: -movement.valueAmount, reversesMovementId: movement.id, disposalType: null, proceedsAmount: null });
      expect(await line(tx, purchase.id, fabricLine.id)).toMatchObject({ defectHeld: 2, returned: 0, outstanding: 0 });
      expect(await getDefectBalance({ kind: "fabric", fabricId: fabric.id }, tx)).toEqual({ qty: 2, valueAmount: 200_000 });
      await expect(reverseDefectMovement(movement.id, staff.id, tx)).rejects.toThrow("sudah dibatalkan");
      await expect(reverseDefectMovement(reversal.id, staff.id, tx)).rejects.toThrow("tidak bisa dibatalkan lagi");

      // Return again, receive the replacement: now the return can no longer be reversed.
      const { movement: again } = await returnDefectsToSupplier({ source: fabricSource(fabricLine.id), qty: 2, reason: "Tukar", occurredAt: OCCURRED }, staff.id, tx);
      const { receipt: replacement } = await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 2 }]);
      const blocked = await rejection(reverseDefectMovement(again.id, staff.id, tx));
      expect(blocked).toBeInstanceOf(ActionError);
      expect(blocked.message).toContain("Batalkan penerimaan pengganti dulu");
      // Reverse the replacement first, then the return reverses fine.
      await reverseGoodsReceipt(replacement.id, staff.id, tx);
      await reverseDefectMovement(again.id, staff.id, tx);
      expect(await line(tx, purchase.id, fabricLine.id)).toMatchObject({ accepted: 8, defectHeld: 2, outstanding: 0 });
    });
  });

  test("reversing a release negates its proceeds and brings the net-loss figures back to their prior values", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await purchaseFixture(tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 8, qtyRejected: 2 }]);
      await disposeDefects({ source: fabricSource(fabricLine.id), qty: 1, disposalType: "donation", proceedsAmount: 0, note: "Hibah", occurredAt: OCCURRED }, staff.id, tx);
      const before = summarizeDefectValues(await listDefectMovementsForPurchase(purchase.id, tx))!;
      const { movement } = await disposeDefects(
        { source: fabricSource(fabricLine.id), qty: 1, disposalType: "auction", proceedsAmount: 130_000, note: "Lelang", occurredAt: OCCURRED },
        staff.id,
        tx,
      );
      const during = summarizeDefectValues(await listDefectMovementsForPurchase(purchase.id, tx))!;
      expect(during.proceeds.auction).toBe(130_000);
      expect(during.netLoss).toBe(100_000 + 100_000 - 130_000);

      const { reversal } = await reverseDefectMovement(movement.id, staff.id, tx);
      expect(reversal).toMatchObject({ qty: 1, valueAmount: 100_000, disposalType: "auction", proceedsAmount: -130_000 });
      expect(summarizeDefectValues(await listDefectMovementsForPurchase(purchase.id, tx))).toEqual(before);
      expect((await line(tx, purchase.id, fabricLine.id)).defectHeld).toBe(1);
    });
  });

  test("a reject is reversed with its receipt, never on its own", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await purchaseFixture(tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 8, qtyRejected: 2 }]);
      const [reject] = await tx.select().from(defectMovements).where(eq(defectMovements.purchaseItemId, fabricLine.id));
      await expect(reverseDefectMovement(reject!.id, staff.id, tx)).rejects.toThrow("Batalkan penerimaan");
    });
  });

  test("a receipt reversal is refused while its defects are returned or released, and allowed once those are reversed", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, fabricLine } = await purchaseFixture(tx);
      const { receipt } = await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 8, qtyRejected: 2 }]);
      const { movement: returned } = await returnDefectsToSupplier({ source: fabricSource(fabricLine.id), qty: 1, reason: "Tukar", occurredAt: OCCURRED }, staff.id, tx);
      const { movement: released } = await disposeDefects(
        { source: fabricSource(fabricLine.id), qty: 1, disposalType: "discarded", proceedsAmount: 0, note: "Dibuang", occurredAt: OCCURRED },
        staff.id,
        tx,
      );
      await expect(reverseGoodsReceipt(receipt.id, staff.id, tx)).rejects.toThrow("Batalkan pengembalian atau pelepasan dulu");
      await reverseDefectMovement(returned.id, staff.id, tx);
      await expect(reverseGoodsReceipt(receipt.id, staff.id, tx)).rejects.toThrow("Batalkan pengembalian atau pelepasan dulu");
      await reverseDefectMovement(released.id, staff.id, tx);
      const { status } = await reverseGoodsReceipt(receipt.id, staff.id, tx);
      expect(status).toBe("ordered");
      expect(await getDefectBalance({ kind: "fabric", fabricId: fabric.id }, tx)).toEqual({ qty: 0, valueAmount: 0 });
    });
  });

  test("reversing a return on a re-opened batch does not re-close it", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, lineA, lineB } = await postedBatch(tx);
      await receiveBatch(tx, batch.id, staff.id, [
        { productionBatchItemId: lineA.id, qtyAccepted: 2, qtyRejected: 1 },
        { productionBatchItemId: lineB.id, qtyAccepted: 2 },
      ]);
      await closeBatchShort(batch.id, "Selesai", staff.id, tx);
      const { movement } = await returnDefectsToSupplier({ source: batchSource(lineA.id), qty: 1, reason: "Perbaikan", occurredAt: OCCURRED }, staff.id, tx);
      await reverseDefectMovement(movement.id, staff.id, tx);
      expect((await batchRow(tx, batch.id)).receiptStatus).toBe("partially_received");
      await closeBatchShort(batch.id, "Tetap cacat", staff.id, tx);
      expect((await batchRow(tx, batch.id)).receiptStatus).toBe("closed");
    });
  });
});

describe("§4.3 variance figures (hand-computed)", () => {
  test("divideRoundHalfUp", () => {
    expect(divideRoundHalfUp(950_000, 4)).toBe(237_500);
    expect(divideRoundHalfUp(10, 4)).toBe(3); // 2.5 → 3
    expect(divideRoundHalfUp(9, 4)).toBe(2); // 2.25 → 2
    expect(divideRoundHalfUp(-10, 4)).toBe(-3);
  });

  /** Batch of 5 pcs at HPP Rp 200.000 (C = Rp 1.000.000): 4 good, 1 defective, then the defect is
   * released and the batch closed. HPP riil = (C − P) / 4. */
  async function settledBatch(tx: TestDatabase, disposalType: "auction" | "donation" | "discarded", proceedsAmount: number) {
    const { staff, batch, lineA, lineB } = await postedBatch(tx);
    await receiveBatch(tx, batch.id, staff.id, [
      { productionBatchItemId: lineA.id, qtyAccepted: 2, qtyRejected: 1 },
      { productionBatchItemId: lineB.id, qtyAccepted: 2 },
    ]);
    await disposeDefects({ source: batchSource(lineA.id), qty: 1, disposalType, proceedsAmount, note: "Pelepasan", occurredAt: OCCURRED }, staff.id, tx);
    await closeBatchShort(batch.id, "Selesai", staff.id, tx);
    const summary = (await getBatchReceiptSummary(batch.id, tx))!;
    const unitCost = new Map([[lineA.id, lineA.unitCostAmount], [lineB.id, lineB.unitCostAmount]]);
    return batchVariance({
      lines: summary.lines.map((row) => ({ received: row.received, outstanding: row.outstanding, unitCostAmount: unitCost.get(row.id)! })),
      closed: summary.receiptStatus === "closed",
      defects: summarizeDefectValues(await listDefectMovementsForBatch(batch.id, tx))!,
    });
  }

  test("lelang for Rp 50.000: net loss 150.000, HPP riil (1.000.000 − 50.000) / 4 = 237.500", async () => {
    await withRollback(async (tx) => {
      const variance = await settledBatch(tx, "auction", 50_000);
      expect(variance).toMatchObject({ sellablePcs: 4, sellableValue: 800_000, unabsorbed: 0, hppRiilPerPcs: 237_500, provisional: false });
      expect(variance.defects).toMatchObject({ held: 0, releasedTotal: 200_000, proceedsTotal: 50_000, netLoss: 150_000 });
    });
  });

  test("hibah: net loss 200.000, HPP riil 1.000.000 / 4 = 250.000, reported as donation not as waste", async () => {
    await withRollback(async (tx) => {
      const variance = await settledBatch(tx, "donation", 0);
      expect(variance.hppRiilPerPcs).toBe(250_000);
      expect(variance.defects.netLossByType).toEqual({ auction: 0, donation: 200_000, discarded: 0 });
    });
  });

  test("dibuang: same formula with P = 0, but on its own line, never folded into hibah (D29)", async () => {
    await withRollback(async (tx) => {
      const variance = await settledBatch(tx, "discarded", 0);
      expect(variance.hppRiilPerPcs).toBe(250_000);
      expect(variance.defects.netLossByType).toEqual({ auction: 0, donation: 0, discarded: 200_000 });
    });
  });

  test("a GAIN: lelang above carried cost gives a negative net loss and HPP riil below HPP/pcs", async () => {
    await withRollback(async (tx) => {
      const variance = await settledBatch(tx, "auction", 300_000);
      expect(variance.defects.netLoss).toBe(-100_000);
      expect(variance.hppRiilPerPcs).toBe(175_000);
    });
  });

  test("while a defect is still held, HPP riil equals HPP/pcs and is marked provisional; a short-close with pcs missing reports Nilai belum terserap", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, lineA, lineB } = await postedBatch(tx);
      await receiveBatch(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 2, qtyRejected: 1 }]);
      const variance = (closed: boolean, summary: NonNullable<Awaited<ReturnType<typeof getBatchReceiptSummary>>>, rows: Awaited<ReturnType<typeof listDefectMovementsForBatch>>) =>
        batchVariance({
          lines: summary.lines.map((row) => ({ received: row.received, outstanding: row.outstanding, unitCostAmount: 200_000 })),
          closed,
          defects: summarizeDefectValues(rows)!,
        });
      const open = variance(false, (await getBatchReceiptSummary(batch.id, tx))!, await listDefectMovementsForBatch(batch.id, tx));
      expect(open).toMatchObject({ hppRiilPerPcs: 200_000, provisional: true, unabsorbed: 0 });
      expect(open.defects.held).toBe(200_000);

      // Line B (2 pcs) never arrives; the defect is donated; batch closed.
      await disposeDefects({ source: batchSource(lineA.id), qty: 1, disposalType: "donation", proceedsAmount: 0, note: "Hibah", occurredAt: OCCURRED }, staff.id, tx);
      await closeBatchShort(batch.id, "Penjahit berhenti", staff.id, tx);
      const closed = variance(true, (await getBatchReceiptSummary(batch.id, tx))!, await listDefectMovementsForBatch(batch.id, tx));
      // (2 × 200.000 sellable + 200.000 loss + 400.000 never arrived) / 2 = 500.000 = C / 2.
      expect(closed).toMatchObject({ unabsorbed: 400_000, hppRiilPerPcs: 500_000, provisional: false });
      expect(lineB.qty).toBe(2);
    });
  });

  test("purchase panel: received, released by type, proceeds, net loss and never-arrived value", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await purchaseFixture(tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 6, qtyRejected: 4 }]);
      await returnDefectsToSupplier({ source: fabricSource(fabricLine.id), qty: 1, reason: "Tukar", occurredAt: OCCURRED }, staff.id, tx);
      await disposeDefects({ source: fabricSource(fabricLine.id), qty: 1, disposalType: "auction", proceedsAmount: 60_000, note: "Lelang", occurredAt: OCCURRED }, staff.id, tx);
      await disposeDefects({ source: fabricSource(fabricLine.id), qty: 1, disposalType: "donation", proceedsAmount: 0, note: "Hibah", occurredAt: OCCURRED }, staff.id, tx);
      await disposeDefects({ source: fabricSource(fabricLine.id), qty: 1, disposalType: "discarded", proceedsAmount: 0, note: "Dibuang", occurredAt: OCCURRED }, staff.id, tx);
      await closePurchase(purchase.id, "Selesai", staff.id, tx);

      const defects = summarizeDefectValues(await listDefectMovementsForPurchase(purchase.id, tx))!;
      const variance = purchaseVariance({
        totalOrdered: 1_060_000,
        sellableValue: await getSellableReceiptValueForPurchase(purchase.id, tx),
        closed: true,
        defects,
      });
      expect(variance.sellableValue).toBe(600_000);
      expect(defects).toMatchObject({
        held: 0,
        returnedValue: 100_000,
        released: { auction: 100_000, donation: 100_000, discarded: 100_000 },
        proceeds: { auction: 60_000, donation: 0, discarded: 0 },
        netLoss: 240_000,
        netLossByType: { auction: 40_000, donation: 100_000, discarded: 100_000 },
      });
      // Never arrived: the returned yard never replaced (100.000) and the whole accessory line (60.000).
      expect(variance.unabsorbed).toBe(160_000);
      // Stripped values (no finance.view_profit) give no figures at all.
      expect(summarizeDefectValues((await listDefectMovementsForPurchase(purchase.id, tx)).map((row) => ({ ...row, valueAmount: null })))).toBeNull();
    });
  });
});

describe("S5b item reads: the Cacat column and the item defect ledger", () => {
  test("the Cacat figures shrink after a return or a release, and the item ledger links each row to its source document", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric, accessory, fabricLine, accessoryLine } = await purchaseFixture(tx);
      await receive(tx, purchase.id, staff.id, [
        { purchaseItemId: fabricLine.id, qtyAccepted: 8, qtyRejected: 2 },
        { purchaseItemId: accessoryLine.id, qtyAccepted: 5, qtyRejected: 1 },
      ]);
      expect(await getDefectQtyByFabric([fabric.id], tx)).toEqual(new Map([[fabric.id, 2]]));
      expect(await getDefectQtyByAccessory([accessory.id], tx)).toEqual(new Map([[accessory.id, 1]]));

      await returnDefectsToSupplier({ source: fabricSource(fabricLine.id), qty: 0.5, reason: "Tukar", occurredAt: OCCURRED }, staff.id, tx);
      await disposeDefects({ source: fabricSource(fabricLine.id), qty: 0.5, disposalType: "auction", proceedsAmount: 20_000, note: "Lelang", occurredAt: OCCURRED }, staff.id, tx);
      await disposeDefects({ source: fabricSource(accessoryLine.id), qty: 1, disposalType: "donation", proceedsAmount: 0, note: "Hibah", occurredAt: OCCURRED }, staff.id, tx);
      expect(await getDefectQtyByFabric([fabric.id], tx)).toEqual(new Map([[fabric.id, 1]]));
      // Zero balances are absent (the column shows a dash).
      expect(await getDefectQtyByAccessory([accessory.id], tx)).toEqual(new Map());

      const ledger = await listItemDefectMovements({ kind: "fabric", fabricId: fabric.id }, tx);
      expect(ledger.map((row) => row.type).sort()).toEqual(["dispose", "reject", "return_out"]);
      expect(ledger.every((row) => row.source.kind === "purchase" && row.source.id === purchase.id && row.source.number === purchase.purchaseNo)).toBe(true);
      expect(ledger.find((row) => row.type === "dispose")).toMatchObject({ proceedsAmount: 20_000, disposalType: "auction", note: "Lelang" });
      const stripped = stripItemDefectAmounts(ledger, false);
      expect(stripped.every((row) => row.valueAmount === null && row.proceedsAmount === null)).toBe(true);
      expect(stripped.map((row) => row.qty)).toEqual(ledger.map((row) => row.qty));
    });
  });

  test("a SKU's ledger links to its batch", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantA, lineA } = await postedBatch(tx);
      await receiveBatch(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 2, qtyRejected: 1 }]);
      expect(await getDefectQtyBySku([variantA.sku], tx)).toEqual(new Map([[variantA.sku, 1]]));
      const [row] = await listItemDefectMovements({ kind: "sku", sku: variantA.sku }, tx);
      expect(row!.source).toEqual({ kind: "batch", id: batch.id, number: batch.batchNo });
    });
  });
});

describe("guards (review follow-up)", () => {
  test("an impossible date, an overlong note, and an unknown movement id are refused cleanly", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await purchaseFixture(tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 8, qtyRejected: 2 }]);
      await expect(returnDefectsToSupplier({ source: fabricSource(fabricLine.id), qty: 1, reason: "x", occurredAt: "2026-02-30" }, staff.id, tx)).rejects.toBeInstanceOf(FieldError);
      await expect(
        disposeDefects({ source: fabricSource(fabricLine.id), qty: 1, disposalType: "discarded", proceedsAmount: 0, note: "x".repeat(1001), occurredAt: OCCURRED }, staff.id, tx),
      ).rejects.toThrow("terlalu panjang");
      await expect(reverseDefectMovement(randomUUID(), staff.id, tx)).rejects.toBeInstanceOf(ActionError);
    });
  });

  test("reversing a return on a document closed again in between keeps it closed, and frees the room again", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await purchaseFixture(tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: fabricLine.id, qtyAccepted: 7.65, qtyRejected: 2.35 }]);
      const { movement } = await returnDefectsToSupplier({ source: fabricSource(fabricLine.id), qty: 2.35, reason: "Tukar", occurredAt: OCCURRED }, staff.id, tx);
      await closePurchase(purchase.id, "Supplier tidak jadi ganti", staff.id, tx);
      await reverseDefectMovement(movement.id, staff.id, tx);
      expect((await purchaseRow(tx, purchase.id)).status).toBe("closed");
      expect(await line(tx, purchase.id, fabricLine.id)).toMatchObject({ defectHeld: 2.35, returned: 0, outstanding: 0 });
    });
  });

  test("on a batch line: release and its reversal", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, variantA, lineA } = await postedBatch(tx);
      await receiveBatch(tx, batch.id, staff.id, [{ productionBatchItemId: lineA.id, qtyAccepted: 1, qtyRejected: 2 }]);
      const { movement } = await disposeDefects(
        { source: batchSource(lineA.id), qty: 2, disposalType: "auction", proceedsAmount: 90_000, note: "Lelang", occurredAt: OCCURRED },
        staff.id,
        tx,
      );
      expect(movement).toMatchObject({ sku: variantA.sku, qty: -2, valueAmount: -400_000, proceedsAmount: 90_000 });
      expect(await getDefectBalance({ kind: "sku", sku: variantA.sku }, tx)).toEqual({ qty: 0, valueAmount: 0 });
      await expect(disposeDefects({ source: batchSource(lineA.id), qty: 0.5, disposalType: "discarded", proceedsAmount: 0, note: "x", occurredAt: OCCURRED }, staff.id, tx)).rejects.toThrow();
      await reverseDefectMovement(movement.id, staff.id, tx);
      expect(await getDefectBalance({ kind: "sku", sku: variantA.sku }, tx)).toEqual({ qty: 2, valueAmount: 400_000 });
      expect((await getBatchReceiptSummary(batch.id, tx))!.lines.find((row) => row.id === lineA.id)).toMatchObject({ defectHeld: 2, released: 0, outstanding: 0 });
    });
  });
});
