import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runPosting, type Database as LedgerDatabase } from "@ammari/accounting/runner";
import { applyPaymentStatus } from "@ammari/commerce/payments";
import { transitionOrderStatus } from "@ammari/commerce/orders";
import { auditLog, businessExpenses, orderItems, payments, privateFiles, shipments, stockMovements, type ChannelId } from "@ammari/db/schema";
import { checkoutOrderValues, insertOrder, insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { getExpenseSummary } from "@/lib/expenses/summary";
import { insertStaffJournal } from "./manual-journals";
import { getPnlReconciliation } from "./pnl-reconciliation";
import { COMPONENT_PROFIT_SIGN } from "./pnl-reconciliation-rules";
import { getBalanceSheet, getCashFlow, getIncomeStatement, recordStatementDownload } from "./statements";
import { getTrialBalance } from "./trial-balance";

// Session 10 against ammari_test (docs/plans/accounting.md §5.4, §6, §6.3): the statements tie out
// (Neraca balances; laba rugi = the movement of the unclosed result in equity; every total matches
// Neraca saldo), the trial month never mixes into 2027 and the opening journal is an opening balance,
// never January's movement; Beban persediaan stays out of HPP (D-7, D-16); omzet is after vouchers,
// without ongkir (D-4, D-6); check 4 against the Biaya tab's own Laba rugi. Every test rolls back.

afterEach(() => {
  vi.useRealTimers();
});

type Line = [code: string, debit: number, credit: number, channel?: ChannelId];

async function books(tx: TestTx) {
  const staff = await insertStaffUser(tx);
  const journal = (entryDate: string, kind: "manual" | "opening", lines: Line[]) =>
    insertStaffJournal(tx, {
      kind,
      entryDate,
      description: "Uji laporan",
      lines: lines.map(([accountCode, debit, credit, channelId]) => ({ accountCode, debit, credit, channelId: channelId ?? null })),
      file: null,
      actorStaffUserId: staff.id,
    });
  // Trial month (D-22): a December sale and a top-up; practice only.
  await journal("2026-12-10", "manual", [["1-1201", 1_000_000, 0], ["4-1105", 0, 1_000_000]]);
  await journal("2026-12-11", "manual", [["1-1603", 500_000, 0], ["1-1201", 0, 500_000]]);
  // Official books: the opening journal (bank 10.000.000, finished goods 4.000.000).
  await journal("2027-01-01", "opening", [["1-1201", 10_000_000, 0], ["1-1504", 4_000_000, 0], ["3-9001", 0, 14_000_000]]);
  // January: a Shopee sale with a seller voucher (M1-shaped) and its HPP, salary, a stock-count
  // difference, owner capital and drawings.
  await journal("2027-01-08", "manual", [["1-1302", 900_000, 0, "shopee"], ["4-1201", 100_000, 0, "shopee"], ["4-1102", 0, 1_000_000, "shopee"]]);
  await journal("2027-01-08", "manual", [["5-1101", 400_000, 0, "shopee"], ["1-1504", 0, 400_000, "shopee"]]);
  await journal("2027-01-20", "manual", [["6-2101", 300_000, 0], ["1-1201", 0, 300_000]]);
  await journal("2027-01-25", "manual", [["6-4101", 50_000, 0], ["1-1504", 0, 50_000]]);
  await journal("2027-01-26", "manual", [["1-1201", 2_000_000, 0], ["3-1001", 0, 2_000_000]]);
  await journal("2027-01-27", "manual", [["3-1002", 100_000, 0], ["1-1201", 0, 100_000]]);
  // February: rent, and the withdrawal Saldo Penjual → Bank (the sale's cash in, D-11).
  await journal("2027-02-05", "manual", [["6-2201", 200_000, 0], ["1-1201", 0, 200_000]]);
  await journal("2027-02-06", "manual", [["1-1201", 900_000, 0], ["1-1302", 0, 900_000]]);
  await tx.execute(sql`set constraints all immediate`);
  await tx.execute(sql`set constraints all deferred`);
  return staff;
}

const row = (statement: { rows: { key: string; amounts: (number | null)[] }[] }, key: string) => statement.rows.find((entry) => entry.key === key)?.amounts;

/** Σ closing (debit − credit) of Neraca saldo rows whose type matches. */
function trialBalanceNet(report: Awaited<ReturnType<typeof getTrialBalance>>, types: string[], movement = false) {
  return report.rows.filter((entry) => types.includes(entry.type)).reduce((sum, entry) => sum + (movement ? entry.debit - entry.credit : entry.closingDebit - entry.closingCredit), 0);
}

const PNL_TYPES = ["revenue", "contra_revenue", "cogs", "expense", "other_income", "other_expense", "tax"];

describe("statements tie out (Session 10)", () => {
  test("Neraca balances and its totals match Neraca saldo; January compares to the official opening, February to 31 Jan", async () => {
    await withRollback(async (tx) => {
      await books(tx);
      const january = await getBalanceSheet("2027-01-31", tx);
      const trial = await getTrialBalance({ from: "2027-01-01", to: "2027-01-31" }, tx);
      expect(january.statement.checks.every((check) => check.ok)).toBe(true);
      expect(january.statement.figures.totalAssets[0]).toBe(trialBalanceNet(trial, ["asset"]));
      expect(january.statement.figures.totalLiabilities[0]).toBe(0 - trialBalanceNet(trial, ["liability"]));
      // Bank 10.000.000 + 2.000.000 − 300.000 − 100.000; Saldo Penjual 900.000; stock 4.000.000 − 400.000 − 50.000.
      expect(row(january.statement, "1-1201")?.[0]).toBe(11_600_000);
      expect(row(january.statement, "1-1504")?.[0]).toBe(3_550_000);
      expect(january.statement.figures.totalAssets[0]).toBe(16_050_000);
      // The December top-up (1-1603) never reaches 2027.
      expect(row(january.statement, "1-1603")).toBeUndefined();
      expect(january.comparison).toEqual({ kind: "opening", asOf: "2027-01-01" });
      expect(january.statement.columns.map((column) => column.label)).toEqual(["31 Jan 2027", "Saldo awal 1 Jan 2027"]);
      expect(january.statement.figures.totalAssets[1]).toBe(14_000_000);
      expect(january.statement.figures.currentEarnings).toEqual([150_000, 0]);

      const february = await getBalanceSheet("2027-02-28", tx);
      expect(february.comparison).toEqual({ kind: "date", asOf: "2027-01-31" });
      expect(february.statement.figures.totalAssets[1]).toBe(january.statement.figures.totalAssets[0]);
      expect(february.statement.checks.every((check) => check.ok)).toBe(true);
    });
  });

  test("Laba rugi: omzet after vouchers, HPP without Beban persediaan, opening and the trial month left out; totals = Neraca saldo", async () => {
    await withRollback(async (tx) => {
      await books(tx);
      const report = await getIncomeStatement({ from: "2027-01-01", to: "2027-01-31" }, "total", tx);
      const { figures } = report.statement;
      expect(figures.grossSales).toEqual([1_000_000]);
      expect(figures.netSales).toEqual([900_000]);
      expect(figures.cogs).toEqual([400_000]);
      expect(figures.operatingExpenses).toEqual([350_000]);
      expect(figures.netIncome).toEqual([150_000]);
      // December's 4-1105 sale never appears in 2027.
      expect(row(report.statement, "4-1105")).toBeUndefined();
      const trial = await getTrialBalance({ from: "2027-01-01", to: "2027-01-31" }, tx);
      expect(figures.netIncome[0]).toBe(-trialBalanceNet(trial, PNL_TYPES, true));

      // A range across the cut-over is the official books only.
      const crossing = await getIncomeStatement({ from: "2026-12-01", to: "2027-01-31" }, "total", tx);
      expect(crossing.range).toMatchObject({ from: "2027-01-01", adjusted: true });
      expect(crossing.statement.figures.netIncome).toEqual([150_000]);
      // The trial month on its own.
      const december = await getIncomeStatement({ from: "2026-12-01", to: "2026-12-31" }, "total", tx);
      expect(december.statement.figures.netIncome).toEqual([1_000_000]);
    });
  });

  test("laba rugi net income equals the movement of the unclosed result in the Neraca, and the equity movement net of capital and drawings", async () => {
    await withRollback(async (tx) => {
      await books(tx);
      const february = await getIncomeStatement({ from: "2027-02-01", to: "2027-02-28" }, "total", tx);
      const sheet = await getBalanceSheet("2027-02-28", tx);
      const [endEarnings, startEarnings] = sheet.statement.figures.currentEarnings;
      expect(february.statement.figures.netIncome[0]).toBe(endEarnings! - startEarnings!);
      expect(february.statement.figures.netIncome[0]).toBe(-200_000);

      const january = await getIncomeStatement({ from: "2027-01-01", to: "2027-01-31" }, "total", tx);
      const januarySheet = await getBalanceSheet("2027-01-31", tx);
      const [equityEnd, equityStart] = januarySheet.statement.figures.totalEquity;
      // Equity grew by the result plus capital paid in (2.000.000) less drawings (100.000).
      expect(equityEnd! - equityStart!).toBe(january.statement.figures.netIncome[0]! + 2_000_000 - 100_000);
    });
  });

  test("per month and per channel columns add up to the total column", async () => {
    await withRollback(async (tx) => {
      await books(tx);
      const byMonth = await getIncomeStatement({ from: "2027-01-01", to: "2027-02-28" }, "month", tx);
      expect(byMonth.statement.columns.map((column) => column.key)).toEqual(["2027-01", "2027-02", "total"]);
      expect(byMonth.statement.figures.netIncome).toEqual([150_000, -200_000, -50_000]);
      // At most 12 month columns: a longer range starts 11 months before its last month, and says so.
      const long = await getIncomeStatement({ from: "2027-01-01", to: "2028-03-31" }, "month", tx);
      expect(long.range.from).toBe("2027-04-01");
      expect(long.monthsClamped).toBe(true);
      expect(long.statement.columns).toHaveLength(13);
      const byChannel = await getIncomeStatement({ from: "2027-01-01", to: "2027-01-31" }, "channel", tx);
      expect(byChannel.statement.columns.map((column) => column.label)).toEqual(["Shopee", "Tanpa saluran", "Jumlah"]);
      expect(byChannel.statement.figures.netSales).toEqual([900_000, 0, 900_000]);
      expect(byChannel.statement.figures.netIncome).toEqual([500_000, -350_000, 150_000]);
      expect(byChannel.statement.checks.every((check) => check.ok)).toBe(true);
    });
  });

  test("Arus kas: opening cash from the opening journal; classified by counter-account; closing = the cash accounts in Neraca saldo", async () => {
    await withRollback(async (tx) => {
      await books(tx);
      const january = await getCashFlow({ from: "2027-01-01", to: "2027-01-31" }, tx);
      const { figures } = january.statement;
      expect(figures.openingCash).toBe(10_000_000);
      // The Shopee sale is on Saldo Penjual, a receivable (0054): not cash until it is withdrawn.
      expect(figures.byActivity).toEqual({ operating: -300_000, investing: 0, financing: 1_900_000, none: 0 });
      expect(row(january.statement, "operating:4-1102")).toBeUndefined();
      expect(figures.closingCash).toBe(11_600_000);
      expect(january.statement.checks.every((check) => check.ok)).toBe(true);
      const trial = await getTrialBalance({ from: "2027-01-01", to: "2027-01-31" }, tx);
      // Cash is Kas tunai and Bank only (0054); the marketplace balances are receivables.
      const cashCodes = ["1-1101", "1-1201"];
      expect(figures.closingCash).toBe(trial.rows.filter((entry) => cashCodes.includes(entry.code)).reduce((sum, entry) => sum + entry.closingDebit - entry.closingCredit, 0));

      // February: the withdrawal Saldo Penjual → Bank is when the sale becomes cash (operating, by the
      // counter-account 1-1302), less the rent.
      const february = await getCashFlow({ from: "2027-02-01", to: "2027-02-28" }, tx);
      expect(february.statement.figures).toMatchObject({ openingCash: 11_600_000, netChange: 700_000, closingCash: 12_300_000 });
      expect(row(february.statement, "operating:1-1302")).toEqual([900_000]);

      // The trial month starts from zero (no opening journal) and stays on its own.
      const december = await getCashFlow({ from: "2026-12-01", to: "2026-12-31" }, tx);
      expect(december.statement.figures).toMatchObject({ openingCash: 0, closingCash: 500_000 });
    });
  });

  test("every download is in Log Aktivitas with its report, period and format", async () => {
    await withRollback(async (tx) => {
      const staff = await books(tx);
      await recordStatementDownload(staff.id, await getBalanceSheet("2027-01-31", tx), "pdf", tx);
      await recordStatementDownload(staff.id, await getIncomeStatement({ from: "2027-01-01", to: "2027-01-31" }, "month", tx), "xlsx", tx);
      await recordStatementDownload(staff.id, await getCashFlow({ from: "2027-01-01", to: "2027-01-31" }, tx), "pdf", tx);
      const rows = await tx.select({ entityType: auditLog.entityType, entityId: auditLog.entityId, after: auditLog.after }).from(auditLog).where(and(eq(auditLog.actorStaffUserId, staff.id), eq(auditLog.action, "download")));
      expect(rows.map((entry) => [entry.entityType, entry.entityId])).toEqual([
        ["balance_sheet", "2027-01-31"],
        ["income_statement", "2027-01-01_2027-01-31"],
        ["cash_flow_statement", "2027-01-01_2027-01-31"],
      ]);
      expect(rows[1]!.after).toMatchObject({ format: "xlsx", view: "month", balanced: true });
    });
  });
});

function setNow(iso: string) {
  vi.useFakeTimers({ now: new Date(iso), toFake: ["Date"] });
}

async function insertExpense(tx: TestTx, staffId: string, date: string, amount: number): Promise<string> {
  const fileId = randomUUID();
  const sha = fileId.replaceAll("-", "").padEnd(64, "0");
  await tx.insert(privateFiles).values({
    id: fileId,
    purpose: "expense_proof",
    storageKey: `test/expense_proof/${fileId}.jpg`,
    contentType: "image/jpeg",
    byteSize: 1,
    sha256: sha,
    originalFilename: "bukti.jpg",
    originalContentType: "image/jpeg",
    originalByteSize: 1,
    originalSha256: sha,
    uploadedByStaffUserId: staffId,
  });
  const [expense] = await tx
    .insert(businessExpenses)
    .values({ expenseNo: `BYA-T-${randomUUID().slice(0, 8)}`, expenseDate: date, category: "packaging", amount, method: "transfer", proofFileId: fileId, recordedByStaffUserId: staffId })
    .returning({ id: businessExpenses.id });
  return expense!.id;
}

describe("check 4: Laba rugi vs the management P&L (Session 10)", () => {
  test("the management side is the Biaya tab's own Laba rugi; ledger side is Laba rugi; every rupiah of difference sits on a line", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await tx.insert(stockMovements).values({ sku: variant.sku, qty: 10, valueAmount: 879_170, type: "production", refType: "manual" });
      // A web order in December: paid, booked (courier 25.000 vs a 24.000 quote, 10.000 subsidy), shipped.
      setNow("2026-12-03T03:00:00Z");
      const order = await insertOrder(tx, { ...checkoutOrderValues(), subtotalAmount: 270_000, discountAmount: 20_000, shippingAmount: 14_000, shippingCostAmount: 24_000, shippingSubsidyAmount: 10_000, totalAmount: 264_000 });
      await tx.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 270_000, unitCost: 0 });
      const providerOrderId = `AMR-${randomUUID().slice(0, 8)}`;
      await tx.insert(payments).values({ orderId: order.id, provider: "midtrans", providerOrderId, attempt: 1, grossAmount: 264_000, status: "pending" });
      await applyPaymentStatus(tx as never, { providerOrderId, transactionStatus: "settlement", transactionId: `tx-${providerOrderId}`, paymentType: "bank_transfer", grossAmount: 264_000, currency: "IDR", fraudStatus: "accept", refundAmount: null, snapshot: { transaction_status: "settlement" } });
      await tx.insert(shipments).values({ orderId: order.id, attempt: 1, referenceId: `REF-${order.orderNo}-K1`, provider: "biteship", providerOrderId: `bs-${randomUUID()}`, courier: "jne", service: "reg", costAmount: 25_000, status: "picked_up", bookedAt: new Date("2026-12-04T02:00:00Z") });
      setNow("2026-12-05T03:00:00Z");
      await transitionOrderStatus(order.id, "shipped", staff.id, tx as never, { courier: "JNE", trackingNumber: "JNE123" });
      // A packaging expense, and a salary accrual by manual journal (not in the management P&L).
      await insertExpense(tx, staff.id, "2026-12-08", 200_000);
      await insertStaffJournal(tx, { kind: "manual", entryDate: "2026-12-31", description: "Akrual gaji", lines: [{ accountCode: "6-2101", debit: 300_000, credit: 0 }, { accountCode: "2-1402", debit: 0, credit: 300_000 }], file: null, actorStaffUserId: staff.id });
      vi.useRealTimers();
      await runPosting(tx as unknown as LedgerDatabase, { trigger: "cron", postingStartDate: "2020-01-01" });
      await tx.execute(sql`set constraints all immediate`);
      await tx.execute(sql`set constraints all deferred`);

      const range = { from: "2026-12-01", to: "2026-12-31" };
      const now = new Date("2027-01-15T03:00:00Z");
      const check = await getPnlReconciliation(range, tx, now);
      const summary = await getExpenseSummary(range, now, tx);
      const ledger = await getIncomeStatement(range, "total", tx);
      expect(check.managementNet).toBe(summary.net);
      expect(check.ledgerNet).toBe(ledger.statement.figures.netIncome[0]);
      const signed = check.components.reduce((sum, component) => sum + COMPONENT_PROFIT_SIGN[component.component] * component.difference, 0);
      expect(signed).toBe(check.ledgerNet - check.managementNet);
      for (const component of check.components) expect(component.lines.reduce((sum, line) => sum + line.amount, 0)).toBe(component.difference);

      const byComponent = Object.fromEntries(check.components.map((component) => [component.component, component]));
      // This order: omzet 250.000 (after the voucher, without ongkir) on both sides.
      expect(byComponent.net_sales!.lines.some((line) => line.sampleKeys.includes(order.id))).toBe(false);
      // The 10.000 web subsidy matches on both sides; the courier 1.000 above the quote is a figure
      // the management P&L does not have (its own component, never a timing difference).
      expect(byComponent.shipping!.lines.some((line) => line.sampleKeys.includes(order.id))).toBe(false);
      expect(byComponent.courier_cost).toMatchObject({ management: 0, ledger: 1_000 });
      // The accrual is a ledger line without an expense record.
      expect(byComponent.operating_expenses!.lines.find((line) => line.cls === "outside")?.amount).toBe(300_000);
      expect(check.labels[order.id]).toBe(order.orderNo);
    });
  });
});
