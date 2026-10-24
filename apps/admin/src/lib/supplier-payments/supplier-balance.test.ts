import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { costComponents, fabrics, purchaseItems, suppliers } from "@ammari/db/schema";
import { recordFabricPurchase } from "@/lib/inventory/fabric-stock";
import { createDraft, postBatch } from "@/lib/production/queries";
import { closePurchase, createPurchase } from "@/lib/purchases/queries";
import { postGoodsReceiptForPurchase } from "@/lib/receipts/queries";
import { listSuppliers } from "@/lib/suppliers/queries";
import type { StoredPrivateFile } from "./store-upload";
import { recordBatchPayment } from "./batch-payments";
import { voidSupplierPayment } from "./payment-records";
import { recordPurchasePayment } from "./purchase-payments";
import { EMPTY_SUPPLIER_BALANCE, getSupplierBalances, getSupplierDebtSummary, getSupplierPayables, supplierBalance } from "./supplier-balance";

// docs/plans/purchase-payments.md P9 / A3 / §9, session S5: "Total utang" per supplier over their
// purchases and their share of posted production batches.

describe("supplierBalance (pure)", () => {
  test("sums the remaining of each document; overpaid stays apart and never settles another document", () => {
    expect(supplierBalance([])).toEqual(EMPTY_SUPPLIER_BALANCE);
    expect(
      supplierBalance([
        { tagihan: 1_000_000, paid: 0 }, // Belum bayar
        { tagihan: 500_000, paid: 300_000 }, // DP
        { tagihan: 200_000, paid: 200_000 }, // Lunas
        { tagihan: 0, paid: 0 }, // Tanpa tagihan
        { tagihan: 0, paid: 100_000 }, // cancelled under a DP: Lebih bayar
        { tagihan: 50_000, paid: 70_000 }, // short-closed below its DP: Lebih bayar
      ]),
    ).toEqual({ outstanding: 1_200_000, overpaid: 120_000, openDocuments: 2 });
  });

  test("rejects a negative or fractional amount instead of hiding it in a total", () => {
    expect(() => supplierBalance([{ tagihan: -1, paid: 0 }])).toThrow();
    expect(() => supplierBalance([{ tagihan: 10, paid: 0.5 }])).toThrow();
  });
});

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function storedFile(): StoredPrivateFile {
  const id = randomUUID();
  return {
    id,
    purpose: "payment_proof",
    storageKey: `test/payment_proof/2026/10/${id}.jpg`,
    processed: {
      body: Buffer.alloc(0),
      contentType: "image/jpeg",
      extension: "jpg",
      byteSize: 1234,
      sha256: sha(id),
      originalFilename: "bukti.jpg",
      originalContentType: "image/jpeg",
      originalByteSize: 2345,
      originalSha256: sha(randomUUID()),
      jpegQuality: 82,
    },
  };
}

async function insertSupplier(tx: TestDatabase, label: string) {
  const [supplier] = await tx.insert(suppliers).values({ name: `${label} ${randomUUID().slice(0, 8)}` }).returning();
  if (!supplier) throw new Error("failed to insert supplier fixture");
  return supplier;
}

async function insertComponent(tx: TestDatabase) {
  const [component] = await tx.insert(costComponents).values({ name: `Ongkos ${randomUUID().slice(0, 8)}`, unit: "pcs", costType: "fixed" }).returning();
  if (!component) throw new Error("failed to insert cost component fixture");
  return component;
}

const payPurchase = (purchaseId: string, amount: number) => ({ purchaseId, paidAt: "2026-10-02", amount, method: "transfer" as const });
const payBatch = (productionBatchId: string, supplierId: string | null, amount: number) => ({
  productionBatchId,
  supplierId,
  paidAt: "2026-10-02",
  amount,
  method: "cash" as const,
});

/** One supplier who sells fabric AND sews:
 *
 * - P1 Rp 1.000.000, nothing paid                     -> owes 1.000.000
 * - P2 Rp 500.000, DP 300.000 + a voided 150.000      -> owes   200.000 (the void doesn't count)
 * - P3 Rp 400.000, paid in full                       -> owes         0 (left out of the breakdown)
 * - P4 Rp 250.000, DP 100.000 then cancelled           -> Lebih bayar 100.000 (owes 0)
 * - posted batch, its sewing line Rp 200.000, DP 50.000 + a voided 20.000
 *                                                      -> owes   150.000
 *   (the same batch's finishing line is someone else's; its unattributed line is nobody's)
 * - a DRAFT batch naming the supplier                 -> nothing yet
 *
 * Plus a second supplier with a purchase of their own, which must never leak into the first's. */
async function fixture(tx: TestDatabase) {
  const staff = await insertStaffUser(tx);
  const supplier = await insertSupplier(tx, "Supplier Utang");
  const other = await insertSupplier(tx, "Supplier Lain");
  const [fabric] = await tx.insert(fabrics).values({ name: `Katun Utang ${randomUUID().slice(0, 8)}` }).returning();
  if (!fabric) throw new Error("fixture");
  const purchase = (supplierId: string, totalAmount: number, orderedAt: string) =>
    createPurchase({ supplierId, orderedAt, lines: [{ itemType: "fabric", itemId: fabric.id, qtyOrdered: 10, totalAmount }] }, staff.id, tx);

  const p1 = await purchase(supplier.id, 1_000_000, "2026-10-01");
  const p2 = await purchase(supplier.id, 500_000, "2026-10-03");
  await recordPurchasePayment(payPurchase(p2.id, 300_000), storedFile(), staff.id, tx);
  const voidedP2 = await recordPurchasePayment(payPurchase(p2.id, 150_000), storedFile(), staff.id, tx);
  await voidSupplierPayment(voidedP2.payment.id, "Salah nominal", staff.id, tx);
  const p3 = await purchase(supplier.id, 400_000, "2026-10-04");
  await recordPurchasePayment(payPurchase(p3.id, 400_000), storedFile(), staff.id, tx);
  const p4 = await purchase(supplier.id, 250_000, "2026-10-05");
  await recordPurchasePayment(payPurchase(p4.id, 100_000), storedFile(), staff.id, tx);
  await closePurchase(p4.id, "Batal pesan", staff.id, tx);
  await purchase(other.id, 9_000_000, "2026-10-01");

  const { fabric: batchFabric, variant } = await insertProductVariant(tx);
  if (!batchFabric || !variant) throw new Error("fixture");
  await recordFabricPurchase({ fabricId: batchFabric.id, qty: 20, totalAmountPaid: 2_000_000, purchasedAt: "2026-09-01" }, null, tx);
  const draftInput = (producedAt: string) => ({
    fabricId: batchFabric.id,
    producedAt,
    fabricYards: 5,
    lines: [{ sku: variant.sku, qty: 5 }],
  });
  const sewing = await insertComponent(tx);
  const finishing = await insertComponent(tx);
  const loose = await insertComponent(tx);
  const batch = await createDraft(
    {
      ...draftInput("2026-10-02"),
      extraCosts: [
        { costComponentId: sewing.id, unitPrice: 200_000, supplierId: supplier.id },
        { costComponentId: finishing.id, unitPrice: 80_000, supplierId: other.id },
        { costComponentId: loose.id, unitPrice: 10_000, supplierId: null },
      ],
    },
    staff.id,
    tx,
  );
  await postBatch(batch.id, staff.id, tx);
  await recordBatchPayment(payBatch(batch.id, supplier.id, 50_000), storedFile(), staff.id, tx);
  const voidedBatch = await recordBatchPayment(payBatch(batch.id, supplier.id, 20_000), storedFile(), staff.id, tx);
  await voidSupplierPayment(voidedBatch.payment.id, "Dobel catat", staff.id, tx);
  await recordBatchPayment(payBatch(batch.id, other.id, 80_000), storedFile(), staff.id, tx);
  await recordBatchPayment(payBatch(batch.id, null, 10_000), storedFile(), staff.id, tx);
  const draft = await createDraft({ ...draftInput("2026-10-06"), extraCosts: [{ costComponentId: sewing.id, unitPrice: 999_000, supplierId: supplier.id }] }, staff.id, tx);

  return { staff, supplier, other, p1, p2, p3, p4, batch, draft };
}

describe("getSupplierDebtSummary (Ringkasan, docs/plans/dashboard-overview.md §5)", () => {
  test("the total equals the sum of every supplier's getSupplierBalances; top suppliers biggest first", async () => {
    await withRollback(async (tx) => {
      const { supplier, other } = await fixture(tx);
      const allIds = (await tx.select({ id: suppliers.id }).from(suppliers)).map((row) => row.id);
      const balances = await getSupplierBalances(allIds, tx);
      const owed = [...balances.entries()].filter(([, balance]) => balance.outstanding > 0);

      const summary = await getSupplierDebtSummary(3, tx);
      expect(summary.totalOutstanding).toBe(owed.reduce((sum, [, balance]) => sum + balance.outstanding, 0));
      expect(summary.suppliersOwed).toBe(owed.length);
      expect(summary.top.length).toBe(Math.min(3, owed.length));
      const outstandings = summary.top.map((row) => row.outstanding);
      expect(outstandings).toEqual([...outstandings].sort((a, b) => b - a));
      // The fixture's two suppliers are the biggest unless ammari_test already holds larger debts.
      const ours = summary.top.filter((row) => row.supplierId === supplier.id || row.supplierId === other.id);
      for (const row of ours) expect(row.outstanding).toBe(balances.get(row.supplierId)!.outstanding);
      // An overpaid document (P4's Lebih bayar 100.000) never reduces the total.
      expect(balances.get(supplier.id)!.outstanding).toBe(1_350_000);
    });
  });
});

describe("getSupplierBalances / getSupplierPayables", () => {
  test("purchases plus the supplier's share of posted batches; voided payments, drafts, other payees excluded; overpaid apart", async () => {
    await withRollback(async (tx) => {
      const { supplier, other, p1, p2, p4, batch } = await fixture(tx);
      const lonely = await insertSupplier(tx, "Supplier Kosong");

      const balances = await getSupplierBalances([supplier.id, other.id, lonely.id], tx);
      expect(balances.get(supplier.id)).toEqual({ outstanding: 1_350_000, overpaid: 100_000, openDocuments: 3 });
      // The other supplier: their own purchase, their finishing line on the batch is paid in full.
      expect(balances.get(other.id)).toEqual({ outstanding: 9_000_000, overpaid: 0, openDocuments: 1 });
      expect(balances.get(lonely.id)).toEqual(EMPTY_SUPPLIER_BALANCE);
      expect(await getSupplierBalances([], tx)).toEqual(new Map());

      const { documents, balance } = await getSupplierPayables(supplier.id, tx);
      // Newest first; the fully paid P3 and the draft batch are not listed.
      expect(documents.map((document) => [document.kind, document.id, document.payment.status, document.payment.remaining, document.payment.overpaid])).toEqual([
        ["purchase", p4.id, "overpaid", 0, 100_000],
        ["purchase", p2.id, "partial", 200_000, 0],
        ["production_batch", batch.id, "partial", 150_000, 0],
        ["purchase", p1.id, "unpaid", 1_000_000, 0],
      ]);
      expect(documents[0]).toMatchObject({ documentNo: p4.purchaseNo, documentDate: "2026-10-05", purchaseStatus: "cancelled" });
      expect(documents[2]).toMatchObject({ documentNo: batch.batchNo, documentDate: "2026-10-02", purchaseStatus: null });
      expect(documents[2]!.payment).toMatchObject({ tagihan: 200_000, paid: 50_000 });
      // The SQL aggregate and the pure function agree.
      expect(balance).toEqual(balances.get(supplier.id));
    });
  });

  test("a short-closed purchase is due only what arrived (A1), the same figure purchaseTagihan gives", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const supplier = await insertSupplier(tx, "Supplier Tutup");
      const [fabric] = await tx.insert(fabrics).values({ name: `Katun Tutup ${randomUUID().slice(0, 8)}` }).returning();
      if (!fabric) throw new Error("fixture");
      const purchase = await createPurchase(
        { supplierId: supplier.id, orderedAt: "2026-10-01", lines: [{ itemType: "fabric", itemId: fabric.id, qtyOrdered: 3, totalAmount: 1_000_000 }] },
        staff.id,
        tx,
      );
      const [line] = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchase.id));
      await postGoodsReceiptForPurchase({ purchaseId: purchase.id, receivedAt: "2026-10-03", lines: [{ purchaseItemId: line!.id, qtyAccepted: 1 }] }, staff.id, tx);
      await closePurchase(purchase.id, "Sisa tidak dikirim", staff.id, tx);
      await recordPurchasePayment(payPurchase(purchase.id, 100_000), storedFile(), staff.id, tx);
      // roundHalfUp(1_000_000 / 3) = 333_333 due, 100_000 paid.
      expect((await getSupplierBalances([supplier.id], tx)).get(supplier.id)).toEqual({ outstanding: 233_333, overpaid: 0, openDocuments: 1 });
      const { documents } = await getSupplierPayables(supplier.id, tx);
      expect(documents.map((document) => [document.purchaseStatus, document.payment.tagihan, document.payment.status])).toEqual([["closed", 333_333, "partial"]]);
    });
  });

  test("listSuppliers' 'Ada utang' filter keeps exactly the suppliers with something left to pay", async () => {
    await withRollback(async (tx) => {
      const { supplier, other } = await fixture(tx);
      const settled = await insertSupplier(tx, "Supplier Utang Lunas");
      const marker = (name: string) => name.split(" ").pop()!;
      for (const target of [supplier, other, settled]) {
        const { rows } = await listSuppliers({ q: marker(target.name), owedOnly: true }, undefined, undefined, tx);
        expect(rows.map((row) => row.id)).toEqual(target === settled ? [] : [target.id]);
      }
      const { rows } = await listSuppliers({ q: marker(settled.name) }, undefined, undefined, tx);
      expect(rows.map((row) => row.id)).toEqual([settled.id]);
    });
  });
});
