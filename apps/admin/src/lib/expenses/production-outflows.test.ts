import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { accessories, costComponents, fabrics, purchaseItems, suppliers } from "@ammari/db/schema";
import { recordFabricPurchase } from "@/lib/inventory/fabric-stock";
import { createDraft, postBatch } from "@/lib/production/queries";
import { closePurchase, createPurchase } from "@/lib/purchases/queries";
import { postGoodsReceiptForPurchase } from "@/lib/receipts/queries";
import { getBatchPaymentSummary, recordBatchPayment } from "@/lib/supplier-payments/batch-payments";
import { voidSupplierPayment } from "@/lib/supplier-payments/payment-records";
import { getPurchasePaymentSummary, recordPurchasePayment } from "@/lib/supplier-payments/purchase-payments";
import type { StoredPrivateFile } from "@/lib/supplier-payments/store-upload";
import { monthRange } from "./figures";
import { getProductionOutflowTotal, listProductionOutflows } from "./production-outflows";

// docs/plans/expense-master-data.md §3.9, session S6: "Pengeluaran produksi" read from the real
// supplier payment write paths (recordPurchasePayment, recordBatchPayment, voidSupplierPayment),
// so the tab's numbering and badge are checked against the PO and batch pages' own summaries.
// Payments are dated in February 2024; every supplier name carries a per-test tag, and the list
// is searched by it, so whatever else ammari_test holds never shows up.

const MONTH = "2024-02";
const OWNER = ["inventory.view", "production.manage", "ads_expenses.manage", "finance.view_profit"];
const KEUANGAN = ["inventory.view", "ads_expenses.manage", "finance.view_profit"];

function storedFile(): StoredPrivateFile {
  const id = randomUUID();
  const sha = createHash("sha256").update(id).digest("hex");
  return {
    id,
    purpose: "payment_proof",
    storageKey: `test/payment_proof/2024/02/${id}.jpg`,
    processed: {
      body: Buffer.alloc(0),
      contentType: "image/jpeg",
      extension: "jpg",
      byteSize: 1,
      sha256: sha,
      originalFilename: "bukti.jpg",
      originalContentType: "image/jpeg",
      originalByteSize: 1,
      originalSha256: createHash("sha256").update(randomUUID()).digest("hex"),
      jpegQuality: 82,
    },
  };
}

async function supplier(tx: TestDatabase, name: string) {
  const [row] = await tx.insert(suppliers).values({ name }).returning();
  if (!row) throw new Error("supplier fixture");
  return row;
}

async function component(tx: TestDatabase, name: string, costType: "variable" | "fixed") {
  const [row] = await tx.insert(costComponents).values({ name, unit: "pcs", costType }).returning();
  if (!row) throw new Error("cost component fixture");
  return row;
}

/** Three POs (fabric + accessory, fabric only, accessory only) from one supplier, and a posted
 * batch with two lines for the tailor, one for the finisher and one nobody was attributed. */
async function fixture(tx: TestDatabase) {
  const tag = `Outflow ${randomUUID().slice(0, 8)}`;
  const staff = await insertStaffUser(tx);
  const vendor = await supplier(tx, `${tag} Toko Kain`);
  const [fabric] = await tx.insert(fabrics).values({ name: `${tag} Katun` }).returning();
  const [accessory] = await tx.insert(accessories).values({ name: `${tag} Kancing` }).returning();
  if (!fabric || !accessory) throw new Error("material fixture");
  const fabricLine = { itemType: "fabric" as const, itemId: fabric.id, qtyOrdered: 10, totalAmount: 1_000_000 };
  const accessoryLine = (qtyOrdered: number, totalAmount: number) => ({ itemType: "accessory" as const, itemId: accessory.id, qtyOrdered, totalAmount });
  const poBoth = await createPurchase({ supplierId: vendor.id, orderedAt: "2024-01-10", lines: [fabricLine, accessoryLine(100, 200_000)] }, staff.id, tx);
  const poFabric = await createPurchase({ supplierId: vendor.id, orderedAt: "2024-01-10", lines: [fabricLine] }, staff.id, tx);
  const poAccessory = await createPurchase({ supplierId: vendor.id, orderedAt: "2024-01-10", lines: [accessoryLine(50, 100_000)] }, staff.id, tx);

  const tailor = await supplier(tx, `${tag} Penjahit`);
  const finisher = await supplier(tx, `${tag} Finishing`);
  const sewing = await component(tx, `Ongkos jahit ${tag}`, "variable");
  const obras = await component(tx, `Obras ${tag}`, "fixed");
  const finishing = await component(tx, `Finishing ${tag}`, "fixed");
  const other = await component(tx, `Lain ${tag}`, "fixed");
  const { fabric: batchFabric, variant } = await insertProductVariant(tx);
  if (!batchFabric || !variant) throw new Error("variant fixture");
  await recordFabricPurchase({ fabricId: batchFabric.id, qty: 10, totalAmountPaid: 1_000_000, purchasedAt: "2023-12-01" }, null, tx);
  const batch = await createDraft(
    {
      fabricId: batchFabric.id,
      producedAt: "2024-01-15",
      fabricYards: 10,
      fabricUsages: [{ fabricColorId: null, yards: 10 }],
      lines: [{ sku: variant.sku, qty: 10 }],
      extraCosts: [
        // Tailor: 10 x 20.000 + 5.000 = 205.000. Finisher 50.000. Unattributed 10.000.
        { costComponentId: sewing.id, unitPrice: 20_000, supplierId: tailor.id },
        { costComponentId: obras.id, unitPrice: 5_000, supplierId: tailor.id },
        { costComponentId: finishing.id, unitPrice: 50_000, supplierId: finisher.id },
        { costComponentId: other.id, unitPrice: 10_000, supplierId: null },
      ],
    },
    staff.id,
    tx,
  );
  await postBatch(batch.id, staff.id, tx);

  const payPurchase = (purchaseId: string, paidAt: string, amount: number) =>
    recordPurchasePayment({ purchaseId, paidAt, amount, method: "transfer" }, storedFile(), staff.id, tx).then((result) => result.payment);
  const payBatch = (supplierId: string | null, paidAt: string, amount: number) =>
    recordBatchPayment({ productionBatchId: batch.id, supplierId, paidAt, amount, method: "cash" }, storedFile(), staff.id, tx).then((result) => result.payment);

  return { tag, staff, vendor, tailor, finisher, poBoth, poFabric, poAccessory, batch, names: { sewing: sewing.name, obras: obras.name, finishing: finishing.name, other: other.name }, payPurchase, payBatch };
}

describe("listProductionOutflows (Pengeluaran produksi)", () => {
  test("rows, labels, numbering, current status and month boundaries from the real payment write paths", async () => {
    await withRollback(async (tx) => {
      const totalBefore = await getProductionOutflowTotal(monthRange(MONTH), tx);
      const f = await fixture(tx);

      // PO with fabric + accessories: DP on the 1st, a voided payment, pelunasan on the 29th.
      const dp = await f.payPurchase(f.poBoth.id, "2024-02-01", 300_000);
      const wrong = await f.payPurchase(f.poBoth.id, "2024-02-02", 100_000);
      await voidSupplierPayment(wrong.id, "Salah nominal", f.staff.id, tx);
      const lunas = await f.payPurchase(f.poBoth.id, "2024-02-29", 900_000);
      // Fabric-only PO: a January DP (outside the month), a February payment, then closed short
      // with 2 of 10 yards: due 200.000, paid 500.000 -> Lebih bayar.
      await f.payPurchase(f.poFabric.id, "2024-01-31", 400_000);
      const fabricSecond = await f.payPurchase(f.poFabric.id, "2024-02-15", 100_000);
      const [fabricLine] = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, f.poFabric.id));
      await postGoodsReceiptForPurchase({ purchaseId: f.poFabric.id, receivedAt: "2024-02-16", lines: [{ purchaseItemId: fabricLine!.id, qtyAccepted: 2 }] }, f.staff.id, tx);
      await closePurchase(f.poFabric.id, "Supplier kehabisan stok", f.staff.id, tx);
      // Accessory-only PO: one payment in February, one on 1 March (outside).
      const accessoryDp = await f.payPurchase(f.poAccessory.id, "2024-02-20", 50_000);
      await f.payPurchase(f.poAccessory.id, "2024-03-01", 30_000);
      // Batch: the tailor twice around a voided payment, the finisher once, the unattributed lines once.
      const tailor1 = await f.payBatch(f.tailor.id, "2024-02-05", 100_000);
      const tailorVoid = await f.payBatch(f.tailor.id, "2024-02-06", 50_000);
      await voidSupplierPayment(tailorVoid.id, "Dobel", f.staff.id, tx);
      const tailor2 = await f.payBatch(f.tailor.id, "2024-02-07", 105_000);
      const finisherDp = await f.payBatch(f.finisher.id, "2024-02-08", 20_000);
      const unattributed = await f.payBatch(null, "2024-02-09", 10_000);

      const { rows, total, pagination } = await listProductionOutflows({ month: MONTH, q: f.tag }, OWNER, undefined, "100", tx);
      // Newest paid date first; voided and out-of-month payments are absent. The unattributed
      // payment has no supplier name, so this search does not match it (checked below).
      expect(rows.map((row) => row.paymentNo)).toEqual(
        [lunas, accessoryDp, fabricSecond, finisherDp, tailor2, tailor1, dp].map((payment) => payment.paymentNo),
      );
      expect(pagination.totalCount).toBe(7);
      expect(total).toBe(900_000 + 50_000 + 100_000 + 20_000 + 105_000 + 100_000 + 300_000);

      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(dp.id)).toMatchObject({
        categoryLabel: "Biaya produksi",
        itemLabel: "Biaya bahan baku",
        itemDetail: "Kain & aksesoris",
        source: "purchase",
        sourceNo: f.poBoth.purchaseNo,
        sourceHref: `/purchases/${f.poBoth.id}`,
        payeeName: f.vendor.name,
        ordinal: 1,
        status: "paid",
        amount: 300_000,
        method: "transfer",
        paidAt: "2024-02-01",
      });
      // The voided payment in between is not counted.
      expect(byId.get(lunas.id)).toMatchObject({ ordinal: 2, status: "paid" });
      expect(byId.get(fabricSecond.id)).toMatchObject({ itemDetail: "Kain", ordinal: 2, status: "overpaid" });
      expect(byId.get(accessoryDp.id)).toMatchObject({ itemDetail: "Aksesoris", ordinal: 1, status: "partial" });

      // The badge is the PO page's.
      expect((await getPurchasePaymentSummary(f.poBoth.id, tx))?.status).toBe("paid");
      expect((await getPurchasePaymentSummary(f.poFabric.id, tx))?.status).toBe("overpaid");
      expect((await getPurchasePaymentSummary(f.poAccessory.id, tx))?.status).toBe("partial");

      // Batch rows: only that payee's components, numbered per payee, the payee's own status.
      const tailorRow = byId.get(tailor2.id)!;
      expect(tailorRow).toMatchObject({ source: "production", sourceNo: f.batch.batchNo, sourceHref: `/production/${f.batch.id}`, itemDetail: null, ordinal: 2, status: "paid", payeeName: f.tailor.name });
      expect(tailorRow.itemLabel.split(", ").sort()).toEqual([f.names.sewing, f.names.obras].sort());
      expect(byId.get(tailor1.id)).toMatchObject({ ordinal: 1, status: "paid", itemLabel: tailorRow.itemLabel });
      expect(byId.get(finisherDp.id)).toMatchObject({ itemLabel: f.names.finishing, ordinal: 1, status: "partial" });
      const batchSummary = await getBatchPaymentSummary(f.batch.id, tx);
      expect(Object.fromEntries(batchSummary!.payees.map((payee) => [payee.supplierId ?? "none", payee.status]))).toEqual({
        [f.tailor.id]: "paid",
        [f.finisher.id]: "partial",
        none: "paid",
      });

      // The unattributed lines, found by the batch number.
      const byBatch = await listProductionOutflows({ month: MONTH, q: f.batch.batchNo }, OWNER, undefined, "100", tx);
      expect(byBatch.rows.map((row) => row.id).sort()).toEqual([tailor1.id, tailor2.id, finisherDp.id, unattributed.id].sort());
      expect(byBatch.rows.find((row) => row.id === unattributed.id)).toMatchObject({ payeeName: "Tanpa penerima", itemLabel: f.names.other, ordinal: 1, status: "paid" });

      // Month boundaries: 31 January and 1 March are outside February; the tile total moves by
      // exactly the February payments.
      expect(await getProductionOutflowTotal(monthRange(MONTH), tx)).toBe(totalBefore + 1_575_000 + 10_000);
      const january = await listProductionOutflows({ month: "2024-01", q: f.tag }, OWNER, undefined, "100", tx);
      expect(january.rows.map((row) => row.paidAt)).toEqual(["2024-01-31"]);
      expect(january.rows[0]).toMatchObject({ ordinal: 1, status: "overpaid" });
      const march = await listProductionOutflows({ month: "2024-03", q: f.tag }, OWNER, undefined, "100", tx);
      expect(march.rows.map((row) => [row.paidAt, row.ordinal])).toEqual([["2024-03-01", 2]]);
    });
  });

  test("Sumber filter, and the batch link is plain text for a viewer without production.manage (Keuangan)", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const po = await f.payPurchase(f.poBoth.id, "2024-02-03", 300_000);
      const batchPayment = await f.payBatch(f.tailor.id, "2024-02-04", 100_000);

      const purchasesOnly = await listProductionOutflows({ month: MONTH, q: f.tag, source: "purchase" }, OWNER, undefined, undefined, tx);
      expect(purchasesOnly.rows.map((row) => row.id)).toEqual([po.id]);
      expect(purchasesOnly.total).toBe(300_000);
      const productionOnly = await listProductionOutflows({ month: MONTH, q: f.tag, source: "production" }, OWNER, undefined, undefined, tx);
      expect(productionOnly.rows.map((row) => row.id)).toEqual([batchPayment.id]);

      const keuangan = await listProductionOutflows({ month: MONTH, q: f.tag }, KEUANGAN, undefined, undefined, tx);
      const byId = new Map(keuangan.rows.map((row) => [row.id, row]));
      expect(byId.get(po.id)?.sourceHref).toBe(`/purchases/${f.poBoth.id}`);
      expect(byId.get(batchPayment.id)).toMatchObject({ sourceHref: null, sourceNo: f.batch.batchNo });
    });
  });

  test("the list is newest first, but the number still counts from the oldest payment", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      await f.payPurchase(f.poBoth.id, "2024-02-01", 100_000);
      const second = await f.payPurchase(f.poBoth.id, "2024-02-02", 100_000);
      const page1 = await listProductionOutflows({ month: MONTH, q: f.tag }, OWNER, "1", "10", tx);
      expect(page1.rows.map((row) => [row.id, row.ordinal, row.status])).toEqual([
        [second.id, 2, "partial"],
        [expect.any(String), 1, "partial"],
      ]);
    });
  });
});
