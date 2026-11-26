import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { fiscalPeriods, journalEntries, journalLines, postingIssues, supplierPayments } from "@ammari/db/schema";
import { insertFabricColor, insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { jakartaDateOf } from "../src/dates";
import { supplierPaymentPaidOutcome } from "../src/rules/supplier-payments";
import { loadSupplierPaymentSnapshots, purchaseChainSource, rawMaterialAdjustmentSource, runPosting, type Database, type PostingSource } from "../src/runner";
import {
  closePurchase,
  insertFabricAdjustment,
  insertPayment,
  insertPurchaseFixture,
  insertReceipt,
  insertReceiptReversal,
  insertReturnOut,
  insertReturnReversal,
  reopenPurchase,
  type PurchaseFixture,
} from "./purchase-fixtures";

// Session 7 against the real database and its 0049 triggers: the purchase document chain (P1-P6)
// and raw-material adjustments (P7). Same harness as runner.test.ts: one rolled-back transaction per
// test, deferred constraints fired after every run, assertions per source (ammari_test may hold
// other suites' committed rows, which the runner also scans).

async function run(tx: TestTx, sources?: PostingSource[]) {
  const result = await runPosting(tx as Database, { trigger: "cron", sources });
  await tx.execute(sql`set constraints all immediate`);
  await tx.execute(sql`set constraints all deferred`);
  return result;
}

const chainSources = () => [purchaseChainSource(), rawMaterialAdjustmentSource()];

async function journalsFor(tx: TestTx, sourceType: string, sourceId: string) {
  const entries = await tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.sourceType, sourceType), eq(journalEntries.sourceId, sourceId)))
    .orderBy(asc(journalEntries.entryNo));
  return Promise.all(
    entries.map(async (entry) => {
      const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, entry.id)).orderBy(asc(journalLines.lineNo));
      return { ...entry, sides: lines.map((line) => (line.debit > 0 ? `Dr ${line.accountCode} ${line.debit}` : `Cr ${line.accountCode} ${line.credit}`)), lines };
    }),
  );
}

/** The supplier's net balance per account over the active and reversal journals (debit positive). */
async function supplierBalances(tx: TestTx, supplierId: string): Promise<Record<string, number>> {
  const rows = await tx
    .select({ code: journalLines.accountCode, net: sql<string>`sum(${journalLines.debit} - ${journalLines.credit})` })
    .from(journalLines)
    .where(eq(journalLines.supplierId, supplierId))
    .groupBy(journalLines.accountCode);
  return Object.fromEntries(rows.map((row) => [row.code, Number(row.net)]).filter(([, net]) => net !== 0));
}

async function openIssuesFor(tx: TestTx, sourceIds: string[]) {
  return tx
    .select({ sourceId: postingIssues.sourceId, sourceEvent: postingIssues.sourceEvent, issueCode: postingIssues.issueCode })
    .from(postingIssues)
    .where(and(inArray(postingIssues.sourceId, sourceIds), isNull(postingIssues.resolvedAt)));
}

async function setup(tx: TestTx): Promise<PurchaseFixture> {
  const staff = await insertStaffUser(tx);
  return insertPurchaseFixture(tx, staff.id);
}

describe("purchase chain (P1-P6) against the database", () => {
  test("DP, receipt with rejects, pelunasan: utang at receipt, DP applied first, everything settles to zero; a second run changes nothing", async () => {
    await withRollback(async (tx) => {
      const fixture = await setup(tx);
      const dp = await insertPayment(tx, fixture, { paidAt: "2026-12-01", amount: 400_000 });
      const received = await insertReceipt(tx, fixture, { receivedAt: "2026-12-05", qtyAccepted: 18, acceptedValue: 900_000, qtyRejected: 2, rejectValue: 100_000 });
      const lunas = await insertPayment(tx, fixture, { paidAt: "2026-12-08", amount: 600_000, method: "cash" });

      const first = await run(tx, chainSources());
      expect(first.failedCount).toBe(0);

      expect((await journalsFor(tx, "supplier_payment", dp)).map((entry) => entry.sides)).toEqual([["Dr 1-1601 400000", "Cr 1-1201 400000"]]);
      const [p1] = await journalsFor(tx, "goods_receipt_item", received.itemId);
      expect(p1).toMatchObject({ sourceEvent: "received", entryDate: "2026-12-05", ruleVersion: 2, kind: "system" });
      expect(p1!.sides).toEqual(["Dr 1-1501 900000", "Dr 1-1506 100000", "Cr 2-1101 600000", "Cr 1-1601 400000"]);
      expect((await journalsFor(tx, "supplier_payment", lunas)).map((entry) => entry.sides)).toEqual([["Dr 2-1101 600000", "Cr 1-1101 600000"]]);
      // Nothing owed, no advance left: only the stock and the cash remain.
      expect(await supplierBalances(tx, fixture.supplierId)).toEqual({ "1-1501": 900_000, "1-1506": 100_000, "1-1201": -400_000, "1-1101": -600_000 });

      const second = await run(tx, chainSources());
      expect(second).toMatchObject({ insertedCount: 0, reversedCount: 0, failedCount: 0 });
    });
  });

  test("Σ P1 of a fully received, closed line equals its tagihan (the line total), and nothing is claimed", async () => {
    await withRollback(async (tx) => {
      const fixture = await setup(tx);
      // Two partial receipts whose slices add up to the line total (1.000.000), one with rejects.
      const a = await insertReceipt(tx, fixture, { receivedAt: "2026-12-03", qtyAccepted: 8, acceptedValue: 400_000, qtyRejected: 2, rejectValue: 100_000 });
      const b = await insertReceipt(tx, fixture, { receivedAt: "2026-12-09", qtyAccepted: 10, acceptedValue: 500_000 });
      await insertPayment(tx, fixture, { paidAt: "2026-12-10", amount: 1_000_000 });
      await closePurchase(tx, fixture, new Date("2026-12-11T03:00:00Z"));

      await run(tx, chainSources());

      const credits = (await Promise.all([a.itemId, b.itemId].map((id) => journalsFor(tx, "goods_receipt_item", id))))
        .flat()
        .flatMap((entry) => entry.lines)
        .reduce((sum, line) => sum + line.credit, 0);
      expect(credits).toBe(1_000_000);
      expect(await journalsFor(tx, "purchase", fixture.purchaseId)).toEqual([]);
      expect((await supplierBalances(tx, fixture.supplierId))["2-1101"]).toBeUndefined();
    });
  });

  test("Session 2 follow-up: a purchase payment posted by the v1 rule (all to utang) is reversed and re-posted with the chain split", async () => {
    await withRollback(async (tx) => {
      const fixture = await setup(tx);
      const paymentId = await insertPayment(tx, fixture, { paidAt: "2026-12-02", amount: 700_000 });
      // What Session 2 posted: supplier_payment v1, "without chain".
      const sessionTwo: PostingSource = {
        name: "supplier_payment",
        ruleVersion: 1,
        async events(db, context) {
          const payments = (await loadSupplierPaymentSnapshots(db)).filter((payment) => payment.id === paymentId);
          return payments.map((payment) => ({ key: { sourceType: "supplier_payment", sourceId: payment.id, sourceEvent: "paid" }, sourceDate: payment.paidAt, outcome: supplierPaymentPaidOutcome(payment, context) }));
        },
      };
      await run(tx, [sessionTwo]);
      expect((await journalsFor(tx, "supplier_payment", paymentId)).map((entry) => entry.sides)).toEqual([["Dr 2-1101 700000", "Cr 1-1201 700000"]]);

      const result = await run(tx, chainSources());

      const journals = await journalsFor(tx, "supplier_payment", paymentId);
      expect(journals.map((entry) => [entry.kind, entry.ruleVersion, entry.sides])).toEqual([
        ["system", 1, ["Dr 2-1101 700000", "Cr 1-1201 700000"]],
        ["reversal", 1, ["Cr 2-1101 700000", "Dr 1-1201 700000"]],
        ["system", 2, ["Dr 1-1601 700000", "Cr 1-1201 700000"]],
      ]);
      expect(result.reversedCount).toBeGreaterThanOrEqual(1);
    });
  });

  test("P2: a receipt reversal negates P1 and gives the advance back; a later receipt uses it again", async () => {
    await withRollback(async (tx) => {
      const fixture = await setup(tx);
      await insertPayment(tx, fixture, { paidAt: "2026-12-01", amount: 300_000 });
      const wrong = await insertReceipt(tx, fixture, { receivedAt: "2026-12-04", qtyAccepted: 10, acceptedValue: 500_000 });
      await run(tx, chainSources());
      const reversalItemId = await insertReceiptReversal(tx, fixture, wrong, "2026-12-06");
      const right = await insertReceipt(tx, fixture, { receivedAt: "2026-12-07", qtyAccepted: 10, acceptedValue: 500_000 });

      await run(tx, chainSources());

      expect((await journalsFor(tx, "goods_receipt_item", reversalItemId)).map((entry) => [entry.sourceEvent, entry.entryDate, entry.sides])).toEqual([
        ["reversed", "2026-12-06", ["Dr 2-1101 200000", "Dr 1-1601 300000", "Cr 1-1501 500000"]],
      ]);
      expect((await journalsFor(tx, "goods_receipt_item", right.itemId)).map((entry) => entry.sides)).toEqual([["Dr 1-1501 500000", "Cr 2-1101 200000", "Cr 1-1601 300000"]]);
      // The original stays active (its negation is a separate key).
      expect((await journalsFor(tx, "goods_receipt_item", wrong.itemId)).map((entry) => entry.reversedByEntryId)).toEqual([null]);
      expect(await supplierBalances(tx, fixture.supplierId)).toEqual({ "1-1501": 500_000, "2-1101": -200_000, "1-1201": -300_000 });
    });
  });

  test("position rule: a DP voided after a receipt used it leaves utang, not a negative advance (posted run after run)", async () => {
    await withRollback(async (tx) => {
      const fixture = await setup(tx);
      const dp = await insertPayment(tx, fixture, { paidAt: "2026-12-01", amount: 500_000 });
      await insertReceipt(tx, fixture, { receivedAt: "2026-12-03", qtyAccepted: 6, acceptedValue: 300_000 });
      await run(tx, chainSources());
      // The one change a payment ever gets: its void stamp (allowed by prevent_supplier_payment_mutation).
      await tx
        .update(supplierPayments)
        .set({ voidedAt: new Date("2026-12-05T03:00:00Z"), voidedByStaffUserId: fixture.staffId, voidReason: "Salah transfer" })
        .where(eq(supplierPayments.id, dp));

      await run(tx, chainSources());

      expect((await journalsFor(tx, "supplier_payment", dp)).map((entry) => [entry.sourceEvent, entry.sides])).toEqual([
        ["paid", ["Dr 1-1601 500000", "Cr 1-1201 500000"]],
        ["void", ["Dr 1-1201 500000", "Cr 2-1101 300000", "Cr 1-1601 200000"]],
      ]);
      expect(await supplierBalances(tx, fixture.supplierId)).toEqual({ "1-1501": 300_000, "2-1101": -300_000 });
    });
  });

  test("P5: closed with advance left → Piutang klaim pemasok; a reopen reverses it; closing again posts it again", async () => {
    await withRollback(async (tx) => {
      const fixture = await setup(tx);
      await insertPayment(tx, fixture, { paidAt: "2026-12-01", amount: 1_000_000 });
      await insertReceipt(tx, fixture, { receivedAt: "2026-12-04", qtyAccepted: 12, acceptedValue: 600_000 });
      await closePurchase(tx, fixture, new Date("2026-12-10T03:00:00Z"));

      await run(tx, chainSources());
      expect((await journalsFor(tx, "purchase", fixture.purchaseId)).map((entry) => [entry.sourceEvent, entry.entryDate, entry.sides])).toEqual([
        ["closed_overpaid", "2026-12-10", ["Dr 1-1402 400000", "Cr 1-1601 400000"]],
      ]);

      await reopenPurchase(tx, fixture, new Date("2026-12-12T03:00:00Z"));
      await run(tx, chainSources());
      expect((await journalsFor(tx, "purchase", fixture.purchaseId)).map((entry) => entry.kind)).toEqual(["system", "reversal"]);
      expect((await supplierBalances(tx, fixture.supplierId))["1-1402"]).toBeUndefined();

      await closePurchase(tx, fixture, new Date("2026-12-14T03:00:00Z"));
      await run(tx, chainSources());
      const journals = await journalsFor(tx, "purchase", fixture.purchaseId);
      expect(journals.map((entry) => [entry.kind, entry.entryDate])).toEqual([
        ["system", "2026-12-10"],
        ["reversal", "2026-12-10"],
        ["system", "2026-12-14"],
      ]);
      expect(await supplierBalances(tx, fixture.supplierId)).toEqual({ "1-1402": 400_000, "1-1501": 600_000, "1-1201": -1_000_000 });
    });
  });

  test("P6: a return to the supplier is a debit note on utang; its reversal is the exact negation", async () => {
    await withRollback(async (tx) => {
      const fixture = await setup(tx);
      await insertReceipt(tx, fixture, { receivedAt: "2026-12-03", qtyAccepted: 8, acceptedValue: 400_000, qtyRejected: 2, rejectValue: 100_000 });
      const back = await insertReturnOut(tx, fixture, { occurredAt: "2026-12-05", qty: 2, value: 100_000 });
      await run(tx, chainSources());
      const undo = await insertReturnReversal(tx, fixture, back, { occurredAt: "2026-12-06", qty: 2, value: 100_000 });
      await run(tx, chainSources());

      expect((await journalsFor(tx, "defect_movement", back)).map((entry) => [entry.sourceEvent, entry.sides])).toEqual([["return_out", ["Dr 2-1101 100000", "Cr 1-1506 100000"]]]);
      expect((await journalsFor(tx, "defect_movement", undo)).map((entry) => [entry.sourceEvent, entry.entryDate, entry.sides])).toEqual([
        ["return_out", "2026-12-06", ["Dr 1-1506 100000", "Cr 2-1101 100000"]],
      ]);
    });
  });

  test("a receipt backdated into a closed month is booked in the first open month; the payment it re-allocates is corrected there too (D-23)", async () => {
    await withRollback(async (tx) => {
      const fixture = await setup(tx);
      const paymentId = await insertPayment(tx, fixture, { paidAt: "2027-01-10", amount: 500_000 });
      await run(tx, chainSources());
      expect((await journalsFor(tx, "supplier_payment", paymentId)).map((entry) => entry.sides)).toEqual([["Dr 1-1601 500000", "Cr 1-1201 500000"]]);
      await tx.insert(fiscalPeriods).values({ month: "2027-01-01", status: "closed", closedAt: new Date(), closedByStaffUserId: fixture.staffId });
      const late = await insertReceipt(tx, fixture, { receivedAt: "2027-01-05", qtyAccepted: 10, acceptedValue: 500_000 });

      await run(tx, chainSources());

      expect((await journalsFor(tx, "goods_receipt_item", late.itemId)).map((entry) => [entry.entryDate, entry.sourceDate, entry.sides])).toEqual([
        ["2027-02-01", "2027-01-05", ["Dr 1-1501 500000", "Cr 2-1101 500000"]],
      ]);
      expect((await journalsFor(tx, "supplier_payment", paymentId)).map((entry) => [entry.kind, entry.entryDate, entry.sides])).toEqual([
        ["system", "2027-01-10", ["Dr 1-1601 500000", "Cr 1-1201 500000"]],
        ["reversal", "2027-02-01", ["Cr 1-1601 500000", "Dr 1-1201 500000"]],
        ["system", "2027-02-01", ["Dr 2-1101 500000", "Cr 1-1201 500000"]],
      ]);
    });
  });

  test("cut-over: a November receipt and its December reversal post nothing; a December payment still clears that utang", async () => {
    await withRollback(async (tx) => {
      const fixture = await setup(tx);
      const november = await insertReceipt(tx, fixture, { receivedAt: "2026-11-20", qtyAccepted: 10, acceptedValue: 500_000 });
      const other = await insertReceipt(tx, fixture, { receivedAt: "2026-11-21", qtyAccepted: 10, acceptedValue: 300_000, accessory: true });
      const reversalItemId = await insertReceiptReversal(tx, fixture, other, "2026-12-02");
      const paymentId = await insertPayment(tx, fixture, { paidAt: "2026-12-03", amount: 500_000 });

      await run(tx, chainSources());

      expect(await journalsFor(tx, "goods_receipt_item", november.itemId)).toEqual([]);
      expect(await journalsFor(tx, "goods_receipt_item", reversalItemId)).toEqual([]);
      expect(await openIssuesFor(tx, [november.itemId, reversalItemId])).toEqual([]);
      expect((await journalsFor(tx, "supplier_payment", paymentId)).map((entry) => entry.sides)).toEqual([["Dr 2-1101 500000", "Cr 1-1201 500000"]]);
    });
  });

  test("a receipt item whose stock-ledger value is missing is an issue, and holds back the rest of the document", async () => {
    await withRollback(async (tx) => {
      const fixture = await setup(tx);
      // Accepted 0 and rejected 2 but no reject row: the value is unknown.
      const broken = await insertReceipt(tx, fixture, { receivedAt: "2026-12-03", qtyAccepted: 0, qtyRejected: 2, rejectValue: 0 });
      await tx.execute(sql`alter table defect_movements disable trigger prevent_defect_movement_mutation`);
      await tx.execute(sql`delete from defect_movements where id = ${broken.rejectMovementId}`);
      await tx.execute(sql`alter table defect_movements enable trigger prevent_defect_movement_mutation`);
      const paymentId = await insertPayment(tx, fixture, { paidAt: "2026-12-04", amount: 100_000 });

      await run(tx, chainSources());

      expect(await journalsFor(tx, "goods_receipt_item", broken.itemId)).toEqual([]);
      expect(await journalsFor(tx, "supplier_payment", paymentId)).toEqual([]);
      expect((await openIssuesFor(tx, [broken.itemId, paymentId])).map((issue) => issue.issueCode).sort()).toEqual(["receipt_value_missing", "receipt_value_missing"]);
    });
  });
});

describe("P7 raw-material adjustments against the database", () => {
  test("damaged fabric → 6-4102, recount gain → 6-4101; a colour reclassification pair posts nothing; idempotent", async () => {
    await withRollback(async (tx) => {
      const fixture = await setup(tx);
      const damaged = await insertFabricAdjustment(tx, fixture, { reason: "damaged", qty: -2, value: -100_000, createdAt: new Date("2026-12-04T18:00:00Z") });
      const recount = await insertFabricAdjustment(tx, fixture, { reason: "recount", qty: 1, value: 50_000, createdAt: new Date("2026-12-05T03:00:00Z") });
      const black = await insertFabricColor(tx, fixture.fabricId);
      const when = new Date("2026-12-06T03:00:00Z");
      const out = await insertFabricAdjustment(tx, fixture, { reason: "other", qty: -3, value: -150_000, createdAt: when, fabricColorId: null });
      const into = await insertFabricAdjustment(tx, fixture, { reason: "other", qty: 3, value: 150_000, createdAt: when, fabricColorId: black.id });

      await run(tx, chainSources());

      const [loss] = await journalsFor(tx, "fabric_stock_movement", damaged);
      expect(loss).toMatchObject({ sourceEvent: "adjustment", entryDate: jakartaDateOf(new Date("2026-12-04T18:00:00Z")) });
      expect(loss!.sides).toEqual(["Dr 6-4102 100000", "Cr 1-1501 100000"]);
      expect((await journalsFor(tx, "fabric_stock_movement", recount)).map((entry) => entry.sides)).toEqual([["Dr 1-1501 50000", "Cr 6-4101 50000"]]);
      expect(await journalsFor(tx, "fabric_stock_movement", out)).toEqual([]);
      expect(await journalsFor(tx, "fabric_stock_movement", into)).toEqual([]);

      const again = await run(tx, [rawMaterialAdjustmentSource()]);
      expect(again).toMatchObject({ insertedCount: 0, reversedCount: 0 });
    });
  });
});
