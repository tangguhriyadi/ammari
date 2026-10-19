import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertAccessory, insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { costComponents, productionBatchItems, purchaseItems, suppliers } from "@ammari/db/schema";
import { recordFabricPurchase } from "@/lib/inventory/fabric-stock";
import { createDraft, postBatch } from "@/lib/production/queries";
import { createPurchase } from "@/lib/purchases/queries";
import { listGoodsReceipts, parseReceiptListFilters } from "./list";
import { postGoodsReceiptForBatch } from "./production";
import { postGoodsReceiptForPurchase, reverseGoodsReceipt } from "./queries";

// docs/plans/suppliers-goods-receipt.md S7: the all-receipts list (/receipts), both sources.

async function insertSupplier(tx: TestDatabase) {
  const [supplier] = await tx
    .insert(suppliers)
    .values({ name: `Supplier List ${randomUUID().slice(0, 8)}` })
    .returning();
  if (!supplier) throw new Error("failed to insert supplier fixture");
  return supplier;
}

/** One purchase from `supplier` (3 pcs of one accessory), received twice: 1 pc on 2026-10-03 and
 * 1 accepted + 1 rejected on 2026-10-06. */
async function purchaseWithTwoReceipts(tx: TestDatabase, staffId: string, supplierId: string) {
  const accessory = await insertAccessory(tx);
  const purchase = await createPurchase(
    { supplierId, orderedAt: "2026-10-01", lines: [{ itemType: "accessory", itemId: accessory.id, qtyOrdered: 3, totalAmount: 300 }] },
    staffId,
    tx,
  );
  const [line] = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchase.id));
  const first = await postGoodsReceiptForPurchase(
    { purchaseId: purchase.id, receivedAt: "2026-10-03", lines: [{ purchaseItemId: line!.id, qtyAccepted: 1 }] },
    staffId,
    tx,
  );
  const second = await postGoodsReceiptForPurchase(
    { purchaseId: purchase.id, receivedAt: "2026-10-06", receivedByName: "Pak Ujang", lines: [{ purchaseItemId: line!.id, qtyAccepted: 1, qtyRejected: 1 }] },
    staffId,
    tx,
  );
  return { purchase, first: first.receipt, second: second.receipt };
}

/** A posted batch whose sewing cost line names `tailorId`, received once on 2026-10-04. */
async function batchWithReceipt(tx: TestDatabase, staffId: string, tailorId: string) {
  const { fabric, variant } = await insertProductVariant(tx);
  await recordFabricPurchase({ fabricId: fabric.id, qty: 2, totalAmountPaid: 100_000, purchasedAt: "2026-09-01" }, null, tx);
  const [component] = await tx
    .insert(costComponents)
    .values({ name: `Jahit List ${randomUUID().slice(0, 8)}`, unit: "pcs", costType: "variable" })
    .returning();
  const batch = await createDraft(
    {
      fabricId: fabric.id,
      producedAt: "2026-10-01",
      fabricYards: 2,
      lines: [{ sku: variant.sku, qty: 2 }],
      extraCosts: [{ costComponentId: component!.id, unitPrice: 1000, supplierId: tailorId }],
    },
    null,
    tx,
  );
  await postBatch(batch.id, staffId, tx);
  const [line] = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, batch.id));
  const { receipt } = await postGoodsReceiptForBatch(
    { batchId: batch.id, receivedAt: "2026-10-04", lines: [{ productionBatchItemId: line!.id, qtyAccepted: 2 }] },
    staffId,
    tx,
  );
  return { batch, receipt };
}

describe("listGoodsReceipts", () => {
  test("lists both sources newest first with their document, supplier, line count and reject flag", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const supplier = await insertSupplier(tx);
      const { purchase, first, second } = await purchaseWithTwoReceipts(tx, staff.id, supplier.id);
      const { batch, receipt: batchReceipt } = await batchWithReceipt(tx, staff.id, supplier.id);

      const { rows } = await listGoodsReceipts({ supplierId: supplier.id }, undefined, undefined, tx);
      expect(rows.map((row) => row.receiptNo)).toEqual([second.receiptNo, batchReceipt.receiptNo, first.receiptNo]);
      expect(rows[0]).toMatchObject({
        source: { type: "purchase", id: purchase.id, documentNo: purchase.purchaseNo },
        supplierNames: [supplier.name],
        receivedAt: "2026-10-06",
        receivedByName: "Pak Ujang",
        lineCount: 1,
        hasRejects: true,
        status: "active",
        createdByName: staff.name,
      });
      expect(rows[1]).toMatchObject({
        source: { type: "production_batch", id: batch.id, documentNo: batch.batchNo },
        supplierNames: [supplier.name],
        hasRejects: false,
      });
    });
  });

  test("filters by source, date range and status; a reversed receipt and its reversal are told apart", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const supplier = await insertSupplier(tx);
      const { first, second } = await purchaseWithTwoReceipts(tx, staff.id, supplier.id);
      const { receipt: batchReceipt } = await batchWithReceipt(tx, staff.id, supplier.id);
      const { reversal } = await reverseGoodsReceipt(second.id, staff.id, tx);

      const list = async (filters: Parameters<typeof listGoodsReceipts>[0]) =>
        (await listGoodsReceipts({ supplierId: supplier.id, ...filters }, undefined, undefined, tx)).rows.map((row) => row.receiptNo);

      expect(await list({ source: "production_batch" })).toEqual([batchReceipt.receiptNo]);
      expect(await list({ source: "purchase", dateFrom: "2026-10-01", dateTo: "2026-10-06" })).toEqual([second.receiptNo, first.receiptNo]);
      expect(await list({ dateFrom: "2026-10-04", dateTo: "2026-10-04" })).toEqual([batchReceipt.receiptNo]);
      expect(await list({ status: "reversed" })).toEqual([second.receiptNo]);
      expect(await list({ status: "reversal" })).toEqual([reversal.receiptNo]);
      expect(await list({ status: "active" })).toEqual([batchReceipt.receiptNo, first.receiptNo]);

      const { rows } = await listGoodsReceipts({ status: "reversal", supplierId: supplier.id }, undefined, undefined, tx);
      expect(rows[0]).toMatchObject({ kind: "reversal", reversesReceiptNo: second.receiptNo });
    });
  });

  test("the supplier filter matches a purchase's supplier or any cost-line supplier of a batch, and nothing else", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const supplierA = await insertSupplier(tx);
      const supplierB = await insertSupplier(tx);
      const { first } = await purchaseWithTwoReceipts(tx, staff.id, supplierA.id);
      const { receipt: batchReceipt } = await batchWithReceipt(tx, staff.id, supplierB.id);

      const forA = await listGoodsReceipts({ supplierId: supplierA.id, source: "purchase" }, undefined, undefined, tx);
      expect(forA.rows.map((row) => row.receiptNo)).toContain(first.receiptNo);
      expect(forA.rows.map((row) => row.receiptNo)).not.toContain(batchReceipt.receiptNo);
      const forB = await listGoodsReceipts({ supplierId: supplierB.id }, undefined, undefined, tx);
      expect(forB.rows.map((row) => row.receiptNo)).toEqual([batchReceipt.receiptNo]);
    });
  });
});

describe("parseReceiptListFilters", () => {
  test("keeps only well-formed values and drops everything else", () => {
    const supplierId = randomUUID();
    expect(
      parseReceiptListFilters({ source: "purchase", supplier: supplierId, from: "2026-10-01", to: "2026-10-31", status: "reversed" }),
    ).toEqual({ source: "purchase", supplierId, dateFrom: "2026-10-01", dateTo: "2026-10-31", status: "reversed" });
    expect(
      parseReceiptListFilters({ source: "sale", supplier: "not-a-uuid", from: "01/10/2026", to: "2026-13-45", status: "deleted" }),
    ).toEqual({});
  });

  test("a reversed range (from after to) is swapped rather than silently returning nothing", () => {
    expect(parseReceiptListFilters({ from: "2026-10-31", to: "2026-10-01" })).toEqual({ dateFrom: "2026-10-01", dateTo: "2026-10-31" });
  });
});
