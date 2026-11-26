import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { supplierPaymentPaidOutcome } from "@ammari/accounting";
import { loadSupplierPaymentSnapshots, runPosting, type Database as LedgerDatabase, type PostingSource } from "@ammari/accounting/runner";
import { costComponents, defectMovements, journalEntries, journalLines, postingIssues, productionBatchItems, stockMovements, suppliers } from "@ammari/db/schema";
import { insertProductVariant, insertStaffUser, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { disposeDefects, returnDefectsToSupplier, reverseDefectMovement } from "@/lib/defects/dispositions";
import { recordFabricPurchase } from "@/lib/inventory/fabric-stock";
import { createDraft, postBatch } from "@/lib/production/queries";
import { closeBatchShort, postGoodsReceiptForBatch } from "@/lib/receipts/production";
import { recordBatchPayment } from "@/lib/supplier-payments/batch-payments";
import type { StoredPrivateFile } from "@/lib/supplier-payments/store-upload";
import { proposeOpeningBalances } from "./opening-balance";
import { getReconciliation } from "./reconciliation";

// Session 8 through the app's REAL production write paths (docs/plans/accounting.md §4.5, §4.6,
// §6.3): post a batch, pay the tailor, receive output (with rejects), short-close, return a defect
// to the tailor (which reopens the batch), receive the replacement, release defects, then the
// posting runner and the Rekonsiliasi checks. The ledger only reads these records. The clock is faked
// through December 2026 (the trial month), since every form refuses a future date. Every test rolls
// back.

afterEach(() => {
  vi.useRealTimers();
});

function setToday(day: string) {
  vi.useFakeTimers({ now: new Date(`${day}T03:00:00Z`), toFake: ["Date"] });
}

function storedFile(): StoredPrivateFile {
  const id = randomUUID();
  const sha = id.replaceAll("-", "").padEnd(64, "d");
  return {
    id,
    purpose: "payment_proof",
    storageKey: `test/payment_proof/2026/12/${id}.jpg`,
    processed: {
      body: Buffer.alloc(0),
      contentType: "image/jpeg",
      extension: "jpg",
      byteSize: 1234,
      sha256: sha,
      originalFilename: "bukti.jpg",
      originalContentType: "image/jpeg",
      originalByteSize: 2345,
      originalSha256: sha,
      jpegQuality: 82,
    },
  };
}

async function postAll(tx: TestTx, sources?: PostingSource[]) {
  const result = await runPosting(tx as unknown as LedgerDatabase, { trigger: "cron", sources });
  await tx.execute(sql`set constraints all immediate`);
  await tx.execute(sql`set constraints all deferred`);
  return result;
}

// Haura, beige: M 12 and L 12 planned. Fabric 10 yards bought for 1.000.003, jahit 40.000/pcs by the
// tailor, finishing 100.000 nobody was attributed. Total 2.060.003, HPP/pcs ceil(/24) = 85.834, so
// 24 pcs are valued 13 over the cost (ROUNDING).
const FABRIC = 1_000_003;
const JAHIT_PER_PCS = 40_000;
const FINISHING = 100_000;
const TOTAL = FABRIC + 24 * JAHIT_PER_PCS + FINISHING;
const UNIT = Math.ceil(TOTAL / 24);
const ROUNDING = 24 * UNIT - TOTAL;

/** A Haura batch posted on 2 Dec 2026. */
async function hauraBatch(tx: TestTx) {
  setToday("2026-12-02");
  const staff = await insertStaffUser(tx);
  const { fabric, color, variant: variantM } = await insertProductVariant(tx);
  const { variant: variantL } = await insertVariantForProduct(tx, fabric.id, color.id, {}, "L");
  const [tailor] = await tx.insert(suppliers).values({ name: `Uji Penjahit Haura ${randomUUID().slice(0, 8)}` }).returning();
  const [sewing] = await tx.insert(costComponents).values({ name: `Ongkos jahit ${randomUUID().slice(0, 8)}`, unit: "pcs", costType: "variable" }).returning();
  const [finishing] = await tx.insert(costComponents).values({ name: `Finishing ${randomUUID().slice(0, 8)}`, unit: "pcs", costType: "fixed" }).returning();
  await recordFabricPurchase({ fabricId: fabric.id, qty: 10, totalAmountPaid: FABRIC, purchasedAt: "2026-09-01" }, null, tx);
  const draft = await createDraft(
    {
      fabricId: fabric.id,
      producedAt: "2026-12-02",
      fabricYards: 10,
      fabricUsages: [{ fabricColorId: null, yards: 10 }],
      lines: [
        { sku: variantM.sku, qty: 12 },
        { sku: variantL.sku, qty: 12 },
      ],
      extraCosts: [
        { costComponentId: sewing!.id, unitPrice: JAHIT_PER_PCS, supplierId: tailor!.id },
        { costComponentId: finishing!.id, unitPrice: FINISHING, supplierId: null },
      ],
    },
    staff.id,
    tx,
  );
  await postBatch(draft.id, staff.id, tx);
  const lines = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, draft.id));
  const lineM = lines.find((line) => line.sku === variantM.sku)!;
  const lineL = lines.find((line) => line.sku === variantL.sku)!;
  expect(lineM.unitCostAmount).toBe(UNIT);
  return { staff, tailor: tailor!, batch: draft, lineM, lineL };
}

/** Every journal (active, superseded and reversals) for one source, oldest first. */
async function journalsFor(tx: TestTx, sourceType: string, sourceId: string) {
  const entries = await tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.sourceType, sourceType), eq(journalEntries.sourceId, sourceId)))
    .orderBy(asc(journalEntries.entryNo));
  return Promise.all(
    entries.map(async (entry) => {
      const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, entry.id)).orderBy(asc(journalLines.lineNo));
      return { ...entry, sides: lines.map((line) => (line.debit > 0 ? `Dr ${line.accountCode} ${line.debit}` : `Cr ${line.accountCode} ${line.credit}`)) };
    }),
  );
}

async function activeJournal(tx: TestTx, sourceType: string, sourceId: string, sourceEvent: string) {
  const all = await journalsFor(tx, sourceType, sourceId);
  return all.filter((entry) => entry.sourceEvent === sourceEvent && entry.kind === "system" && entry.reversedByEntryId === null);
}

async function openIssues(tx: TestTx, sourceIds: string[]) {
  if (sourceIds.length === 0) return [];
  return tx.select({ code: postingIssues.issueCode }).from(postingIssues).where(and(inArray(postingIssues.sourceId, sourceIds), isNull(postingIssues.resolvedAt)));
}

async function receiptItemIds(tx: TestTx, batchId: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select gri.id from goods_receipt_items gri join goods_receipts gr on gr.id = gri.goods_receipt_id where gr.production_batch_id = ${batchId}
  `)) as unknown as { id: string }[];
  return rows.map((row) => row.id);
}

describe("Session 8 through the real production write paths", () => {
  test("Haura beige L: 12 planned, 6 made, short-closed → the missing pieces' cost goes to 6-4102; WIP and stock reconcile; idempotent", async () => {
    await withRollback(async (tx) => {
      const { staff, tailor, batch, lineM, lineL } = await hauraBatch(tx);
      setToday("2026-12-05");
      await recordBatchPayment({ productionBatchId: batch.id, supplierId: tailor.id, paidAt: "2026-12-05", amount: 500_000, method: "transfer" }, storedFile(), staff.id, tx);
      setToday("2026-12-10");
      await postGoodsReceiptForBatch(
        { batchId: batch.id, receivedAt: "2026-12-10", lines: [{ productionBatchItemId: lineM.id, qtyAccepted: 12 }, { productionBatchItemId: lineL.id, qtyAccepted: 6 }] },
        staff.id,
        tx,
      );

      const first = await postAll(tx);
      expect(first.failedCount).toBe(0);
      const [r1] = await activeJournal(tx, "production_batch", batch.id, "posted");
      expect(r1).toMatchObject({ entryDate: "2026-12-02", ruleVersion: 2 });
      expect(r1!.sides).toEqual([`Dr 1-1503 ${TOTAL}`, `Cr 1-1501 ${FABRIC}`, `Cr 2-1102 ${24 * JAHIT_PER_PCS}`, `Cr 2-1103 ${FINISHING}`]);
      expect(ROUNDING).toBe(13);
      // Still in production: no WIP close yet.
      expect(await activeJournal(tx, "production_batch", batch.id, "wip_close")).toEqual([]);

      setToday("2026-12-15");
      await closeBatchShort(batch.id, "Salah potong kain, Haura beige L hanya jadi 6", staff.id, tx);
      const second = await postAll(tx);
      expect(second.failedCount).toBe(0);
      const rest = TOTAL - 18 * UNIT;
      const [r3] = await activeJournal(tx, "production_batch", batch.id, "wip_close");
      expect(r3).toMatchObject({ entryDate: "2026-12-15" });
      expect(r3!.sides).toEqual([`Dr 6-4102 ${rest}`, `Cr 1-1503 ${rest}`]);
      expect(rest).toBe(6 * UNIT - ROUNDING);

      expect(await openIssues(tx, [batch.id, ...(await receiptItemIds(tx, batch.id))])).toEqual([]);

      const report = await getReconciliation("2026-12-20", tx);
      const wipRow = report.wipBatches.find((row) => row.batchId === batch.id);
      // Production ended and R3 settled it: nothing left in process, nothing to show.
      expect(wipRow).toBeUndefined();
      for (const row of report.stockAccounts) expect(row.difference, row.accountCode).toBe(0);
      const fabric = report.materials.find((row) => row.material === "fabric")!;
      expect(fabric.production).toBeLessThanOrEqual(-FABRIC);
      expect(fabric.difference).toBe(0);

      // A third run changes nothing.
      expect(await postAll(tx)).toMatchObject({ insertedCount: 0, reversedCount: 0, failedCount: 0 });
    });
  });

  test("reject, short-close, return to the tailor (reopens), replacement: R3 is reversed and re-posted as the rounding residue (5-1201)", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, lineM, lineL } = await hauraBatch(tx);
      setToday("2026-12-10");
      await postGoodsReceiptForBatch(
        { batchId: batch.id, receivedAt: "2026-12-10", lines: [{ productionBatchItemId: lineM.id, qtyAccepted: 12 }, { productionBatchItemId: lineL.id, qtyAccepted: 11, qtyRejected: 1 }] },
        staff.id,
        tx,
      );
      setToday("2026-12-11");
      await closeBatchShort(batch.id, "Satu potong cacat", staff.id, tx);
      await postAll(tx);
      const [closed] = await activeJournal(tx, "production_batch", batch.id, "wip_close");
      // All 24 arrived (one defective): the rest is the rounding, but the batch was short-closed → 6-4102.
      expect(closed!.sides).toEqual([`Dr 1-1503 ${ROUNDING}`, `Cr 6-4102 ${ROUNDING}`]);

      setToday("2026-12-12");
      const { movement, reopened } = await returnDefectsToSupplier({ source: { productionBatchItemId: lineL.id }, qty: 1, reason: "Tukar ke penjahit", occurredAt: "2026-12-12" }, staff.id, tx);
      expect(reopened).toBe(true);
      const afterReturn = await postAll(tx);
      expect(afterReturn.failedCount).toBe(0);
      expect((await activeJournal(tx, "defect_movement", movement.id, "return_out"))[0]!.sides).toEqual([`Dr 1-1503 ${UNIT}`, `Cr 1-1506 ${UNIT}`]);
      // Running again: R3 is un-posted (reversal), nothing active.
      expect(await activeJournal(tx, "production_batch", batch.id, "wip_close")).toEqual([]);
      const reportOpen = await getReconciliation("2026-12-12", tx);
      const openRow = reportOpen.wipBatches.find((row) => row.batchId === batch.id)!;
      expect(openRow).toMatchObject({ appWip: UNIT - ROUNDING, ledger: UNIT - ROUNDING, difference: 0, status: "ok" });

      setToday("2026-12-14");
      await postGoodsReceiptForBatch({ batchId: batch.id, receivedAt: "2026-12-14", lines: [{ productionBatchItemId: lineL.id, qtyAccepted: 1 }] }, staff.id, tx);
      await postAll(tx);
      const [received] = await activeJournal(tx, "production_batch", batch.id, "wip_close");
      expect(received).toMatchObject({ entryDate: "2026-12-14" });
      expect(received!.sides).toEqual([`Dr 1-1503 ${ROUNDING}`, `Cr 5-1201 ${ROUNDING}`]);
      // History: the short-close R3, its reversal, the completion R3.
      expect((await journalsFor(tx, "production_batch", batch.id)).filter((entry) => entry.sourceEvent === "wip_close").map((entry) => entry.kind)).toEqual(["system", "reversal", "system"]);

      const report = await getReconciliation("2026-12-20", tx);
      for (const row of report.stockAccounts) expect(row.difference, row.accountCode).toBe(0);
      expect(await postAll(tx)).toMatchObject({ insertedCount: 0, reversedCount: 0, failedCount: 0 });
    });
  });

  test("A2: an auctioned defect is 6-4103 with the proceeds as Pendapatan lain-lain; its reversal mirrors it", async () => {
    await withRollback(async (tx) => {
      const { staff, batch, lineL } = await hauraBatch(tx);
      setToday("2026-12-10");
      await postGoodsReceiptForBatch({ batchId: batch.id, receivedAt: "2026-12-10", lines: [{ productionBatchItemId: lineL.id, qtyAccepted: 10, qtyRejected: 2 }] }, staff.id, tx);
      setToday("2026-12-13");
      const released = await disposeDefects(
        { source: { productionBatchItemId: lineL.id }, qty: 2, disposalType: "auction", proceedsAmount: 60_000, note: "Lelang ke pengepul", occurredAt: "2026-12-13" },
        staff.id,
        tx,
      );
      const disposeId = released.movement.id;
      await postAll(tx);
      expect((await activeJournal(tx, "defect_movement", disposeId, "dispose"))[0]!.sides).toEqual([`Dr 6-4103 ${2 * UNIT}`, "Dr 1-1101 60000", `Cr 1-1506 ${2 * UNIT}`, "Cr 7-1101 60000"]);

      setToday("2026-12-14");
      await reverseDefectMovement(disposeId, staff.id, tx);
      const [reversal] = await tx.select().from(defectMovements).where(eq(defectMovements.reversesMovementId, disposeId));
      await postAll(tx);
      expect((await activeJournal(tx, "defect_movement", reversal!.id, "dispose"))[0]!.sides).toEqual([`Dr 1-1506 ${2 * UNIT}`, "Dr 7-1101 60000", `Cr 6-4103 ${2 * UNIT}`, "Cr 1-1101 60000"]);
      const report = await getReconciliation("2026-12-20", tx);
      expect(report.stockAccounts.find((row) => row.kind === "defect")!.difference).toBe(0);
    });
  });

  test("A1: a finished-goods count loss is 6-4101, damage 6-4102, at the movement's value", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const [loss] = await tx
        .insert(stockMovements)
        .values({ sku: variant.sku, qty: -1, valueAmount: -87_917, type: "adjustment", refType: "manual", reason: "recount", createdAt: new Date("2026-12-09T03:00:00Z") })
        .returning();
      const [damage] = await tx
        .insert(stockMovements)
        .values({ sku: variant.sku, qty: -1, valueAmount: -87_917, type: "adjustment", refType: "manual", reason: "damaged", createdAt: new Date("2026-12-09T04:00:00Z") })
        .returning();
      await postAll(tx);
      expect((await activeJournal(tx, "stock_movement", loss!.id, "adjustment"))[0]!.sides).toEqual(["Dr 6-4101 87917", "Cr 1-1504 87917"]);
      expect((await activeJournal(tx, "stock_movement", damage!.id, "adjustment"))[0]!.sides).toEqual(["Dr 6-4102 87917", "Cr 1-1504 87917"]);
    });
  });

  test("R4: a batch payment posted by the Session 2 rule (v1) is re-derived on the position rule (production_chain v2)", async () => {
    await withRollback(async (tx) => {
      const { staff, tailor, batch } = await hauraBatch(tx);
      setToday("2026-12-05");
      const payment = await recordBatchPayment({ productionBatchId: batch.id, supplierId: tailor.id, paidAt: "2026-12-05", amount: 300_000, method: "cash" }, storedFile(), staff.id, tx);
      const paymentId = payment.payment.id;
      // What Sessions 2-7 posted for a batch payment: rule supplier_payment v1, "without chain".
      const legacy: PostingSource = {
        name: "supplier_payment",
        ruleVersion: 1,
        async events(db, context) {
          const rows = await loadSupplierPaymentSnapshots(db);
          return rows
            .filter((row) => row.id === paymentId)
            .map((row) => ({ key: { sourceType: "supplier_payment", sourceId: row.id, sourceEvent: "paid" }, sourceDate: row.paidAt, outcome: supplierPaymentPaidOutcome(row, context) }));
        },
      };
      await postAll(tx, [legacy]);
      expect((await activeJournal(tx, "supplier_payment", paymentId, "paid"))[0]).toMatchObject({ ruleVersion: 1 });

      const result = await postAll(tx);
      expect(result.failedCount).toBe(0);
      const history = await journalsFor(tx, "supplier_payment", paymentId);
      expect(history.map((entry) => [entry.kind, entry.ruleVersion])).toEqual([
        ["system", 1],
        ["reversal", 1],
        ["system", 2],
      ]);
      expect(history[2]!.sides).toEqual(["Dr 2-1102 300000", "Cr 1-1101 300000"]);
      expect(await postAll(tx)).toMatchObject({ insertedCount: 0, reversedCount: 0, failedCount: 0 });
    });
  });

  test("opening balance (D-22): a batch short-closed in December that gets a return to the tailor in January is still in process at the cut-over, as R3 dates its end", async () => {
    await withRollback(async (tx) => {
      const wipProposal = async () => (await proposeOpeningBalances(tx)).find((proposal) => proposal.key === "inventory.wip")?.amount ?? 0;
      const baseline = await wipProposal();
      const { staff, batch, lineM } = await hauraBatch(tx);
      setToday("2026-12-10");
      await postGoodsReceiptForBatch({ batchId: batch.id, receivedAt: "2026-12-10", lines: [{ productionBatchItemId: lineM.id, qtyAccepted: 11, qtyRejected: 1 }] }, staff.id, tx);
      setToday("2026-12-20");
      await closeBatchShort(batch.id, "Sisa tidak dijahit", staff.id, tx);
      // Closed before the cut-over with nothing after it: R3 settled it in December, nothing to carry.
      expect(await wipProposal()).toBe(baseline);

      setToday("2027-01-05");
      await returnDefectsToSupplier({ source: { productionBatchItemId: lineM.id }, qty: 1, reason: "Tukar ke penjahit", occurredAt: "2027-01-05" }, staff.id, tx);
      // R3 now ends on 5 Jan 2027, so on 31 Dec the batch still held cost − the 12 pcs that arrived.
      expect((await wipProposal()) - baseline).toBe(TOTAL - 12 * UNIT);
    });
  });
});
