import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertFabricColor, insertStaffUser } from "@ammari/db/test-fixtures";
import { auditLog, defectMovements, fabrics, fabricStockMovements, purchaseItems, suppliers } from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { getFabricBalance, getFabricColorBalance, listFabricColorBalances } from "@/lib/inventory/fabric-stock";
import { createPurchase, getPurchaseDocument } from "@/lib/purchases/queries";
import { disposeDefects, returnDefectsToSupplier } from "@/lib/defects/dispositions";
import {
  getDefectBalance,
  getFabricDefectQtyByColor,
  listDefectMovementsForPurchase,
  listDefectStockMaterials,
  listItemDefectMovements,
} from "@/lib/defects/queries";
import { listReceiptsForPurchase, postGoodsReceiptForPurchase, reverseGoodsReceipt } from "./queries";

// docs/plans/fabric-colour-stock.md session S3: receipts, their reversal, defects, exchange and
// release per colour. The colour always comes from the purchase line (D5); every scenario ends by
// checking that the colour buckets still add up to the fabric total, qty AND value.

const RECEIVED_AT = "2026-11-05";
const OCCURRED = "2026-11-06";

async function insertSupplier(tx: TestDatabase) {
  const [supplier] = await tx.insert(suppliers).values({ name: `Supplier Warna ${randomUUID().slice(0, 8)}` }).returning();
  return supplier!;
}

async function insertFabric(tx: TestDatabase) {
  const [fabric] = await tx.insert(fabrics).values({ name: `Marbella ${randomUUID().slice(0, 8)}` }).returning();
  return fabric!;
}

/** PO-202611-001 in small: Sage 10 yard Rp 195.000, Mocca 8 yard Rp 160.000 (a different price per
 * yard), Tosca 5 yard Rp 97.500. */
async function threeColourPurchase(tx: TestDatabase) {
  const staff = await insertStaffUser(tx);
  const supplier = await insertSupplier(tx);
  const fabric = await insertFabric(tx);
  const sage = await insertFabricColor(tx, fabric.id, { name: "Sage", hex: "#9CAF88" });
  const mocca = await insertFabricColor(tx, fabric.id, { name: "Mocca", hex: "#8B6B4A" });
  const tosca = await insertFabricColor(tx, fabric.id, { name: "Tosca", hex: "#40B5AD" });
  const purchase = await createPurchase(
    {
      supplierId: supplier.id,
      orderedAt: "2026-11-01",
      lines: [
        { itemType: "fabric", itemId: fabric.id, fabricColorId: sage.id, qtyOrdered: 10, totalAmount: 195_000 },
        { itemType: "fabric", itemId: fabric.id, fabricColorId: mocca.id, qtyOrdered: 8, totalAmount: 160_000 },
        { itemType: "fabric", itemId: fabric.id, fabricColorId: tosca.id, qtyOrdered: 5, totalAmount: 97_500 },
      ],
    },
    staff.id,
    tx,
  );
  const lines = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchase.id));
  const lineOf = (colorId: string) => lines.find((line) => line.fabricColorId === colorId)!;
  return { staff, supplier, fabric, sage, mocca, tosca, purchase, sageLine: lineOf(sage.id), moccaLine: lineOf(mocca.id), toscaLine: lineOf(tosca.id) };
}

function receive(tx: TestDatabase, purchaseId: string, actorId: string, lines: { purchaseItemId: string; qtyAccepted: number; qtyRejected?: number }[]) {
  return postGoodsReceiptForPurchase({ purchaseId, receivedAt: RECEIVED_AT, lines }, actorId, tx);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected promise to reject, but it resolved");
}

/** Every colour bucket (incl. Tanpa warna) of the fabric adds up to the fabric's total, qty and value. */
async function expectBucketsAddUp(tx: TestDatabase, fabricId: string) {
  const total = await getFabricBalance(fabricId, tx);
  const buckets = await listFabricColorBalances(fabricId, tx);
  const qtyCenti = buckets.reduce((sum, bucket) => sum + Math.round(bucket.qty * 100), 0);
  const value = buckets.reduce((sum, bucket) => sum + bucket.valueAmount, 0);
  expect(qtyCenti).toBe(Math.round(total.qty * 100));
  expect(value).toBe(total.valueAmount);
}

/** A consumption from one bucket after the receipt (stands in for an S5 production movement). */
async function consume(tx: TestDatabase, fabricId: string, fabricColorId: string | null, qty: number, valueAmount: number) {
  await tx.insert(fabricStockMovements).values({
    fabricId,
    fabricColorId,
    qty: -qty,
    valueAmount: -valueAmount,
    type: "production",
    refType: "production_batch",
    refId: randomUUID(),
  });
}

describe("postGoodsReceiptForPurchase per colour", () => {
  test("one ledger row per colour line, each with its line's colour and its own value slice; a reject stays on its colour's line", async () => {
    await withRollback(async (tx) => {
      const { staff, fabric, sage, mocca, tosca, purchase, sageLine, moccaLine, toscaLine } = await threeColourPurchase(tx);
      await receive(tx, purchase.id, staff.id, [
        { purchaseItemId: sageLine.id, qtyAccepted: 10 },
        { purchaseItemId: moccaLine.id, qtyAccepted: 7, qtyRejected: 1 },
        { purchaseItemId: toscaLine.id, qtyAccepted: 3 },
      ]);

      const rows = await tx.select().from(fabricStockMovements).where(eq(fabricStockMovements.fabricId, fabric.id));
      expect(rows.map((row) => ({ color: row.fabricColorId, qty: row.qty, value: row.valueAmount })).sort((a, b) => b.qty - a.qty)).toEqual([
        { color: sage.id, qty: 10, value: 195_000 },
        { color: mocca.id, qty: 7, value: 140_000 },
        { color: tosca.id, qty: 3, value: 58_500 },
      ]);
      // Per-colour average cost (A1): Sage 19.500/yard, Mocca 20.000/yard.
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 10, valueAmount: 195_000 });
      expect(await getFabricColorBalance(fabric.id, mocca.id, tx)).toEqual({ qty: 7, valueAmount: 140_000 });
      expect(await getFabricColorBalance(fabric.id, tosca.id, tx)).toEqual({ qty: 3, valueAmount: 58_500 });
      expect(await getFabricColorBalance(fabric.id, null, tx)).toEqual({ qty: 0, valueAmount: 0 });

      // The defective yard: on the Mocca line, never in a sellable bucket.
      const defects = await tx.select().from(defectMovements).where(eq(defectMovements.fabricId, fabric.id));
      expect(defects.map((row) => ({ line: row.purchaseItemId, qty: row.qty, value: row.valueAmount }))).toEqual([{ line: moccaLine.id, qty: 1, value: 20_000 }]);
      expect(await getFabricDefectQtyByColor(fabric.id, tx)).toEqual([{ fabricColorId: mocca.id, name: "Mocca", hex: "#8B6B4A", qty: 1 }]);
      await expectBucketsAddUp(tx, fabric.id);
    });
  });

  test("partial receipts: the rest of a colour arrives later into the same bucket at the line's remaining value", async () => {
    await withRollback(async (tx) => {
      const { staff, fabric, tosca, purchase, toscaLine } = await threeColourPurchase(tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: toscaLine.id, qtyAccepted: 3 }]);
      await expectBucketsAddUp(tx, fabric.id);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: toscaLine.id, qtyAccepted: 2 }]);
      expect(await getFabricColorBalance(fabric.id, tosca.id, tx)).toEqual({ qty: 5, valueAmount: 97_500 });
      await expectBucketsAddUp(tx, fabric.id);
    });
  });

  test("over-receipt is checked per colour line and the message names the colour", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, moccaLine, sageLine } = await threeColourPurchase(tx);
      const error = await rejection(receive(tx, purchase.id, staff.id, [{ purchaseItemId: moccaLine.id, qtyAccepted: 8, qtyRejected: 0.5 }]));
      expect(error).toBeInstanceOf(FieldError);
      expect(error.message).toContain(", Mocca");
      expect(error.message).toContain("8.00 yard");
      // Another colour's room is independent: Sage 10 is still fine.
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: sageLine.id, qtyAccepted: 10 }]);
    });
  });

  test("a legacy colourless line of a fabric that has colours still receives into Tanpa warna", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const supplier = await insertSupplier(tx);
      const fabric = await insertFabric(tx);
      // Ordered before the fabric had any colour (S2 allows Tanpa warna then)...
      const purchase = await createPurchase(
        { supplierId: supplier.id, orderedAt: "2026-11-01", lines: [{ itemType: "fabric", itemId: fabric.id, qtyOrdered: 30, totalAmount: 585_000 }] },
        staff.id,
        tx,
      );
      // ...and the colours were added before it arrived.
      await insertFabricColor(tx, fabric.id, { name: "Sage" });
      const [line] = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchase.id));
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: line!.id, qtyAccepted: 30 }]);
      expect(await getFabricColorBalance(fabric.id, null, tx)).toEqual({ qty: 30, valueAmount: 585_000 });
      const document = await getPurchaseDocument(purchase.id, tx);
      expect(document!.lines[0]).toMatchObject({ fabricColorId: null, fabricHasActiveColors: true });
      await expectBucketsAddUp(tx, fabric.id);
    });
  });

  test("the audit entry and the receipt history carry each line's colour", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, sage, mocca, sageLine, moccaLine } = await threeColourPurchase(tx);
      const { receipt } = await receive(tx, purchase.id, staff.id, [
        { purchaseItemId: sageLine.id, qtyAccepted: 10 },
        { purchaseItemId: moccaLine.id, qtyAccepted: 7, qtyRejected: 1 },
      ]);
      const [entry] = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "goods_receipt"), eq(auditLog.entityId, receipt.id)));
      const lines = (entry!.after as { lines: { purchaseItemId: string; fabricColorId: string | null; colorName: string | null }[] }).lines;
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ purchaseItemId: sageLine.id, fabricColorId: sage.id, colorName: "Sage", qtyAccepted: 10, qtyRejected: 0 }),
          expect.objectContaining({ purchaseItemId: moccaLine.id, fabricColorId: mocca.id, colorName: "Mocca", qtyAccepted: 7, qtyRejected: 1 }),
        ]),
      );
      const [history] = await listReceiptsForPurchase(purchase.id, tx);
      expect(history!.items.map((item) => [item.colorName, item.colorHex])).toEqual(expect.arrayContaining([["Sage", sage.hex], ["Mocca", mocca.hex]]));
    });
  });
});

describe("reverseGoodsReceipt per colour", () => {
  test("allowed after another colour was consumed; the voids keep each row's colour and the buckets still add up", async () => {
    await withRollback(async (tx) => {
      const { staff, fabric, sage, mocca, purchase, sageLine, moccaLine } = await threeColourPurchase(tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: sageLine.id, qtyAccepted: 10 }]);
      const { receipt } = await receive(tx, purchase.id, staff.id, [{ purchaseItemId: moccaLine.id, qtyAccepted: 7, qtyRejected: 1 }]);
      // Sage is cut AFTER the Mocca receipt; Tanpa warna too.
      await consume(tx, fabric.id, sage.id, 4, 78_000);
      await consume(tx, fabric.id, null, 1, 0);

      await reverseGoodsReceipt(receipt.id, staff.id, tx);
      expect(await getFabricColorBalance(fabric.id, mocca.id, tx)).toEqual({ qty: 0, valueAmount: 0 });
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 6, valueAmount: 117_000 });
      expect(await getDefectBalance({ kind: "fabric", fabricId: fabric.id }, tx)).toEqual({ qty: 0, valueAmount: 0 });
      const voids = await tx.select().from(fabricStockMovements).where(and(eq(fabricStockMovements.fabricId, fabric.id), eq(fabricStockMovements.type, "purchase_void")));
      expect(voids.map((row) => row.fabricColorId)).toEqual([mocca.id]);
      await expectBucketsAddUp(tx, fabric.id);

      const [entry] = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "goods_receipt"), eq(auditLog.entityId, receipt.id), eq(auditLog.action, "reverse")));
      expect((entry!.after as { lines: unknown[] }).lines).toEqual([expect.objectContaining({ purchaseItemId: moccaLine.id, fabricColorId: mocca.id, colorName: "Mocca" })]);
    });
  });

  test("refused when the SAME colour was consumed after the receipt", async () => {
    await withRollback(async (tx) => {
      const { staff, fabric, mocca, purchase, moccaLine } = await threeColourPurchase(tx);
      const { receipt } = await receive(tx, purchase.id, staff.id, [{ purchaseItemId: moccaLine.id, qtyAccepted: 8 }]);
      await consume(tx, fabric.id, mocca.id, 1, 20_000);
      const error = await rejection(reverseGoodsReceipt(receipt.id, staff.id, tx));
      expect(error).toBeInstanceOf(ActionError);
      expect(error.message).toContain("sudah dipakai atau disesuaikan");
    });
  });

  test("a mixed receipt is refused when any of its colours was consumed after it", async () => {
    await withRollback(async (tx) => {
      const { staff, fabric, tosca, purchase, sageLine, toscaLine } = await threeColourPurchase(tx);
      const { receipt } = await receive(tx, purchase.id, staff.id, [
        { purchaseItemId: sageLine.id, qtyAccepted: 10 },
        { purchaseItemId: toscaLine.id, qtyAccepted: 5 },
      ]);
      await consume(tx, fabric.id, tosca.id, 1, 19_500);
      await expect(reverseGoodsReceipt(receipt.id, staff.id, tx)).rejects.toThrow("sudah dipakai atau disesuaikan");
    });
  });

  test("a Tanpa warna receipt is refused by a later Tanpa warna consumption, not by a colour's", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const supplier = await insertSupplier(tx);
      const fabric = await insertFabric(tx);
      const purchase = await createPurchase(
        { supplierId: supplier.id, orderedAt: "2026-11-01", lines: [{ itemType: "fabric", itemId: fabric.id, qtyOrdered: 10, totalAmount: 100_000 }] },
        staff.id,
        tx,
      );
      const sage = await insertFabricColor(tx, fabric.id, { name: "Sage" });
      const [line] = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchase.id));
      const first = await receive(tx, purchase.id, staff.id, [{ purchaseItemId: line!.id, qtyAccepted: 4 }]);
      const second = await receive(tx, purchase.id, staff.id, [{ purchaseItemId: line!.id, qtyAccepted: 6 }]);
      // A colour bucket's movement does not block the Tanpa warna receipt...
      await tx.insert(fabricStockMovements).values({ fabricId: fabric.id, fabricColorId: sage.id, qty: 1, valueAmount: 0, type: "adjustment", refType: "manual", reason: "other" });
      await reverseGoodsReceipt(second.receipt.id, staff.id, tx);
      // ...but a Tanpa warna consumption after it does.
      await consume(tx, fabric.id, null, 1, 10_000);
      await expect(reverseGoodsReceipt(first.receipt.id, staff.id, tx)).rejects.toThrow("sudah dipakai atau disesuaikan");
      await expectBucketsAddUp(tx, fabric.id);
    });
  });

  test("the negative-stock backstop is per bucket: a colour short of the receipt's qty refuses even if the fabric total is fine", async () => {
    await withRollback(async (tx) => {
      const { staff, fabric, mocca, purchase, sageLine, moccaLine } = await threeColourPurchase(tx);
      // A Mocca consumption committed with an EARLIER timestamp than the receipt (created_at is the
      // transaction start), so the later-movement check cannot see it: only the backstop can.
      await tx.insert(fabricStockMovements).values({
        fabricId: fabric.id,
        fabricColorId: mocca.id,
        qty: -2,
        valueAmount: 0,
        type: "production",
        refType: "production_batch",
        refId: randomUUID(),
        createdAt: new Date("2026-01-01T00:00:00Z"),
      });
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: sageLine.id, qtyAccepted: 10 }]);
      const { receipt } = await receive(tx, purchase.id, staff.id, [{ purchaseItemId: moccaLine.id, qtyAccepted: 1 }]);
      expect((await getFabricBalance(fabric.id, tx)).qty).toBe(9);
      await expect(reverseGoodsReceipt(receipt.id, staff.id, tx)).rejects.toThrow("negatif");
    });
  });
});

describe("defects, exchange and release per colour", () => {
  test("exchange: returning Mocca's defect re-opens the Mocca line and the replacement lands in Mocca", async () => {
    await withRollback(async (tx) => {
      const { staff, fabric, sage, mocca, purchase, sageLine, moccaLine } = await threeColourPurchase(tx);
      await receive(tx, purchase.id, staff.id, [
        { purchaseItemId: sageLine.id, qtyAccepted: 10 },
        { purchaseItemId: moccaLine.id, qtyAccepted: 6, qtyRejected: 2 },
      ]);
      const { movement } = await returnDefectsToSupplier({ source: { purchaseItemId: moccaLine.id }, qty: 2, reason: "Noda, tukar", occurredAt: OCCURRED }, staff.id, tx);
      expect(await getFabricDefectQtyByColor(fabric.id, tx)).toEqual([]);
      await expectBucketsAddUp(tx, fabric.id);

      const [entry] = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "defect_movement"), eq(auditLog.entityId, movement.id)));
      expect((entry!.after as { line: unknown }).line).toEqual(expect.objectContaining({ purchaseItemId: moccaLine.id, fabricColorId: mocca.id, colorName: "Mocca" }));

      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: moccaLine.id, qtyAccepted: 2 }]);
      expect(await getFabricColorBalance(fabric.id, mocca.id, tx)).toEqual({ qty: 8, valueAmount: 160_000 });
      expect(await getFabricColorBalance(fabric.id, sage.id, tx)).toEqual({ qty: 10, valueAmount: 195_000 });
      await expectBucketsAddUp(tx, fabric.id);
    });
  });

  test("a disposition's over-quantity message names the colour", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, moccaLine } = await threeColourPurchase(tx);
      await receive(tx, purchase.id, staff.id, [{ purchaseItemId: moccaLine.id, qtyAccepted: 7, qtyRejected: 1 }]);
      const error = await rejection(returnDefectsToSupplier({ source: { purchaseItemId: moccaLine.id }, qty: 2, reason: "x", occurredAt: OCCURRED }, staff.id, tx));
      expect(error.message).toContain(", Mocca");
    });
  });

  test("release: the colour's defect drops, sellable buckets are untouched, the lists show the colour", async () => {
    await withRollback(async (tx) => {
      const { staff, fabric, mocca, tosca, purchase, moccaLine, toscaLine } = await threeColourPurchase(tx);
      await receive(tx, purchase.id, staff.id, [
        { purchaseItemId: moccaLine.id, qtyAccepted: 6, qtyRejected: 2 },
        { purchaseItemId: toscaLine.id, qtyAccepted: 4.5, qtyRejected: 0.5 },
      ]);
      const before = await listFabricColorBalances(fabric.id, tx);

      const materials = (await listDefectStockMaterials(tx)).find((row) => row.id === fabric.id)!;
      expect(materials.qty).toBe(2.5);
      expect(materials.colors).toEqual([
        { fabricColorId: mocca.id, name: "Mocca", hex: "#8B6B4A", qty: 2 },
        { fabricColorId: tosca.id, name: "Tosca", hex: "#40B5AD", qty: 0.5 },
      ]);

      const { movement } = await disposeDefects(
        { source: { purchaseItemId: moccaLine.id }, qty: 2, disposalType: "auction", proceedsAmount: 10_000, note: "Lelang", occurredAt: OCCURRED },
        staff.id,
        tx,
      );
      expect(await listFabricColorBalances(fabric.id, tx)).toEqual(before);
      expect(await getFabricDefectQtyByColor(fabric.id, tx)).toEqual([{ fabricColorId: tosca.id, name: "Tosca", hex: "#40B5AD", qty: 0.5 }]);
      await expectBucketsAddUp(tx, fabric.id);

      const [entry] = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "defect_movement"), eq(auditLog.entityId, movement.id)));
      expect((entry!.after as { line: unknown }).line).toEqual(expect.objectContaining({ fabricColorId: mocca.id, colorName: "Mocca" }));

      const history = await listDefectMovementsForPurchase(purchase.id, tx);
      expect(history.find((row) => row.type === "dispose")).toMatchObject({ itemName: fabric.name, colorName: "Mocca", colorHex: "#8B6B4A" });
      const ledger = await listItemDefectMovements({ kind: "fabric", fabricId: fabric.id }, tx);
      expect(ledger.map((row) => row.colorName).sort()).toEqual(["Mocca", "Mocca", "Tosca"]);
    });
  });
});
