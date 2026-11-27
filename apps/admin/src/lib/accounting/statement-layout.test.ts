import { describe, expect, test } from "vitest";
import type { AccountType, CashFlowGroup } from "@ammari/db/schema";
import { allocateCashFlow, buildBalanceSheet, buildCashFlowStatement, buildIncomeStatement, type StatementAccount } from "./statement-layout";

// The statement layouts (docs/plans/accounting.md §6, Session 10) from a trial balance, without a
// database: sections by account type and the header tree, 6-4000 Beban persediaan under beban
// usaha and never in HPP (D-7, D-16), the Neraca balancing through the unclosed result, and the
// direct-method Arus kas.

const a = (code: string, name: string, type: AccountType, options: { parent?: string; header?: boolean; group?: CashFlowGroup } = {}): StatementAccount => ({
  code,
  name,
  type,
  parentCode: options.parent ?? null,
  isHeader: options.header ?? false,
  isActive: true,
  cashFlowGroup: options.group ?? (options.header ? "none" : "operating"),
});

const CHART: StatementAccount[] = [
  a("1-1000", "Aset lancar", "asset", { header: true }),
  a("1-1100", "Kas", "asset", { parent: "1-1000", header: true }),
  a("1-1101", "Kas tunai", "asset", { parent: "1-1100", group: "cash" }),
  a("1-1200", "Bank", "asset", { parent: "1-1000", header: true }),
  a("1-1201", "Bank utama", "asset", { parent: "1-1200", group: "cash" }),
  a("1-1300", "Saldo pembayaran & marketplace", "asset", { parent: "1-1000", header: true }),
  a("1-1302", "Saldo Penjual Shopee", "asset", { parent: "1-1300", group: "cash" }),
  a("1-1500", "Persediaan", "asset", { parent: "1-1000", header: true }),
  a("1-1504", "Persediaan barang jadi", "asset", { parent: "1-1500" }),
  a("1-1505", "Barang terjual belum dikirim", "asset", { parent: "1-1500" }),
  a("1-1506", "Persediaan barang cacat", "asset", { parent: "1-1500" }),
  a("1-2000", "Aset tetap", "asset", { header: true }),
  a("1-2102", "Peralatan kantor & komputer", "asset", { parent: "1-2000", group: "investing" }),
  a("1-2192", "Akumulasi penyusutan peralatan kantor", "asset", { parent: "1-2000", group: "investing" }),
  a("2-1101", "Utang usaha pemasok bahan", "liability"),
  a("2-1203", "Titipan ongkir pembeli", "liability"),
  a("2-2101", "Utang bank/pinjaman", "liability", { group: "financing" }),
  a("3-1001", "Modal pemilik", "equity", { group: "financing" }),
  a("3-1002", "Prive", "equity", { group: "financing" }),
  a("3-9001", "Ekuitas saldo awal", "equity", { group: "none" }),
  a("4-1100", "Penjualan", "revenue", { header: true }),
  a("4-1101", "Penjualan Website", "revenue", { parent: "4-1100" }),
  a("4-1102", "Penjualan Shopee", "revenue", { parent: "4-1100" }),
  a("4-1201", "Potongan penjualan", "contra_revenue"),
  a("4-1301", "Retur penjualan", "contra_revenue"),
  a("5-1101", "HPP barang jadi", "cogs"),
  a("5-1201", "Selisih biaya produksi", "cogs"),
  a("6-1000", "Beban penjualan & pemasaran", "expense", { header: true }),
  a("6-1201", "Biaya platform marketplace", "expense", { parent: "6-1000" }),
  a("6-2000", "Beban umum & administrasi", "expense", { header: true }),
  a("6-2101", "Gaji", "expense", { parent: "6-2000" }),
  a("6-3101", "Ongkir bahan", "expense"),
  a("6-4000", "Beban persediaan", "expense", { header: true }),
  a("6-4101", "Selisih persediaan", "expense", { parent: "6-4000" }),
  a("6-4102", "Kerusakan & kehilangan persediaan", "expense", { parent: "6-4000" }),
  a("6-4103", "Barang cacat dilepas", "expense", { parent: "6-4000" }),
  a("7-1101", "Hasil lelang barang cacat", "other_income"),
  a("8-1101", "Administrasi bank", "other_expense"),
  a("9-1101", "Beban PPh final", "tax"),
];
const ACCOUNTS = new Map(CHART.map((account) => [account.code, account]));

/** debit − credit per account; one column. */
const one = (entries: Record<string, number>) => new Map(Object.entries(entries).map(([code, value]) => [code, [value]]));
const amountOf = (rows: { key: string; amounts: (number | null)[] }[], key: string) => rows.find((row) => row.key === key)?.amounts;

describe("Laba rugi", () => {
  const movements = one({
    "4-1101": -1_000_000,
    "4-1102": -2_000_000,
    "4-1201": 100_000,
    "4-1301": 200_000,
    "5-1101": 1_200_000,
    "5-1201": -3,
    "6-1201": 150_000,
    "6-2101": 300_000,
    "6-3101": 20_000,
    "6-4101": 40_000,
    "6-4102": 60_000,
    "6-4103": 25_000,
    "7-1101": -10_000,
    "8-1101": 5_000,
    "9-1101": 13_500,
  });
  const statement = buildIncomeStatement(CHART, movements, [{ key: "total", label: "Jumlah" }]);

  test("penjualan − potongan & retur = penjualan bersih (D-4: after vouchers; ongkir is never revenue)", () => {
    expect(statement.figures.grossSales).toEqual([3_000_000]);
    expect(statement.figures.netSales).toEqual([2_700_000]);
  });

  test("HPP is only the cogs accounts (5-1101 + 5-1201); Beban persediaan 6-4000 sits in beban usaha (D-7, D-16)", () => {
    expect(statement.figures.cogs).toEqual([1_199_997]);
    expect(statement.figures.grossProfit).toEqual([1_500_003]);
    const hppSection = statement.rows.slice(statement.rows.findIndex((row) => row.key === "cogs"), statement.rows.findIndex((row) => row.key === "gross_profit"));
    expect(hppSection.map((row) => row.accountCode).filter(Boolean)).toEqual(["5-1101", "5-1201"]);
    const expenseSection = statement.rows.slice(statement.rows.findIndex((row) => row.key === "expense"), statement.rows.findIndex((row) => row.key === "operating_profit"));
    expect(expenseSection.map((row) => row.accountCode).filter(Boolean)).toEqual(["6-1201", "6-2101", "6-3101", "6-4101", "6-4102", "6-4103"]);
    expect(amountOf(statement.rows, "6-4000:subtotal")).toEqual([125_000]);
    expect(statement.figures.operatingExpenses).toEqual([595_000]);
  });

  test("± lain-lain, − PPh final = laba bersih, equal to Σ (credit − debit) of every P&L account", () => {
    expect(statement.figures.profitBeforeTax).toEqual([1_500_003 - 595_000 + 10_000 - 5_000]);
    expect(statement.figures.netIncome).toEqual([1_500_003 - 595_000 + 10_000 - 5_000 - 13_500]);
    expect(statement.checks.every((check) => check.ok)).toBe(true);
  });

  test("header groups: a heading, the accounts, and a Jumlah row only when more than one child shows", () => {
    expect(statement.rows.filter((row) => row.key.startsWith("4-1100")).map((row) => [row.key, row.style])).toEqual([
      ["4-1100:group", "group"],
      ["4-1100:subtotal", "subtotal"],
    ]);
    // A header with one account shown has no Jumlah row.
    const single = buildIncomeStatement(CHART, one({ "6-2101": 1, "4-1101": -1 }), [{ key: "total", label: "Jumlah" }]);
    expect(single.rows.some((row) => row.key === "6-2000:subtotal")).toBe(false);
    expect(single.rows.some((row) => row.key === "6-2000:group")).toBe(true);
    // Accounts at zero and empty headers are left out.
    expect(single.rows.some((row) => row.key === "6-4000:group")).toBe(false);
  });

  test("multiple columns (per month / per channel) are summed column by column", () => {
    const columns = [
      { key: "2027-01", label: "Jan 2027" },
      { key: "2027-02", label: "Feb 2027" },
      { key: "total", label: "Jumlah" },
    ];
    const byMonth = new Map([
      ["4-1101", [-100, -200, -300]],
      ["5-1101", [40, 70, 110]],
      ["6-4102", [0, 5, 5]],
    ]);
    const multi = buildIncomeStatement(CHART, byMonth, columns);
    expect(multi.figures.netIncome).toEqual([60, 125, 185]);
    expect(multi.checks[0]!.ok).toBe(true);
  });
});

describe("Neraca", () => {
  const balances = one({
    "1-1101": 500_000,
    "1-1201": 9_000_000,
    "1-1504": 4_000_000,
    "1-2102": 6_000_000,
    "1-2192": -1_000_000,
    "2-1101": -2_500_000,
    "2-2101": -3_000_000,
    "3-1001": -12_900_000,
    "3-1002": 200_000,
    // The period's result, not yet closed: revenue 2.000.000, costs 1.700.000 → laba 300.000.
    "4-1101": -2_000_000,
    "5-1101": 1_200_000,
    "6-2101": 500_000,
  });
  const sheet = buildBalanceSheet(CHART, balances, [{ key: "2027-01-31", label: "31 Jan 2027" }]);

  test("aset on the debit side (accumulated depreciation negative), kewajiban and ekuitas on the credit side", () => {
    expect(sheet.figures.totalAssets).toEqual([18_500_000]);
    expect(amountOf(sheet.rows, "1-2192")).toEqual([-1_000_000]);
    expect(sheet.figures.totalLiabilities).toEqual([5_500_000]);
    expect(amountOf(sheet.rows, "3-1002")).toEqual([-200_000]);
  });

  test("short- and long-term liabilities split by the chart's 2-1 / 2-2 convention", () => {
    expect(amountOf(sheet.rows, "liabilities:short:total")).toEqual([2_500_000]);
    expect(amountOf(sheet.rows, "liabilities:long:total")).toEqual([3_000_000]);
  });

  test("the unclosed P&L result is equity, so the Neraca balances", () => {
    expect(sheet.figures.currentEarnings).toEqual([300_000]);
    expect(amountOf(sheet.rows, "equity:current_earnings")).toEqual([300_000]);
    expect(sheet.figures.totalEquity).toEqual([13_000_000]);
    expect(amountOf(sheet.rows, "liabilities_equity:total")).toEqual([18_500_000]);
    expect(sheet.checks).toEqual([{ label: "31 Jan 2027: jumlah aset sama dengan jumlah kewajiban dan ekuitas", ok: true }]);
  });

  test("an unbalanced input fails the check (never hidden)", () => {
    const broken = buildBalanceSheet(CHART, one({ "1-1201": 100 }), [{ key: "x", label: "X" }]);
    expect(broken.checks[0]!.ok).toBe(false);
  });
});

describe("Arus kas (direct method)", () => {
  const line = (entryId: string, accountCode: string, net: number) => ({ entryId, accountCode, net });
  const lines = [
    // M1 + HPP: Saldo Penjual 270.000 in, Penjualan 300.000, Potongan 30.000; HPP pair rides along.
    line("s3", "1-1302", 270_000),
    line("s3", "4-1201", 30_000),
    line("s3", "4-1102", -300_000),
    line("s3", "5-1101", 120_000),
    line("s3", "1-1505", -120_000),
    // E1: Gaji out of the bank.
    line("e1", "6-2101", 500_000),
    line("e1", "1-1201", -500_000),
    // Owner capital into the bank.
    line("m1", "1-1201", 2_000_000),
    line("m1", "3-1001", -2_000_000),
    // A computer paid from the bank (investing).
    line("fa", "1-2102", 1_500_000),
    line("fa", "1-1201", -1_500_000),
    // Withdrawal Saldo Penjual → Bank: no cash moved.
    line("wd", "1-1201", 200_000),
    line("wd", "1-1302", -200_000),
    // A purchase on credit: no cash line at all.
    line("p1", "1-1504", 800_000),
    line("p1", "2-1101", -800_000),
  ];
  const allocation = allocateCashFlow(lines, ACCOUNTS);

  test("each cash movement is classified by its counter-accounts; the HPP pair never shows as cash", () => {
    expect(Object.fromEntries(allocation.byActivity.operating)).toEqual({ "4-1102": 300_000, "4-1201": -30_000, "6-2101": -500_000 });
    expect(Object.fromEntries(allocation.byActivity.investing)).toEqual({ "1-2102": -1_500_000 });
    expect(Object.fromEntries(allocation.byActivity.financing)).toEqual({ "3-1001": 2_000_000 });
    expect(allocation.netChange).toBe(270_000);
  });

  test("a transfer between cash accounts and a purchase on credit are no cash flow", () => {
    expect([...allocation.byActivity.operating.keys()]).not.toContain("1-1504");
    expect([...allocation.byActivity.operating.keys()]).not.toContain("2-1101");
    expect([...allocation.byActivity.operating.keys()]).not.toContain("1-1302");
  });

  test("a discount equal to the HPP is never netted against it (sales lines are never netted)", () => {
    const tricky = allocateCashFlow(
      [line("x", "1-1302", 70_000), line("x", "4-1201", 30_000), line("x", "4-1102", -100_000), line("x", "5-1101", 30_000), line("x", "1-1505", -30_000)],
      ACCOUNTS,
    );
    expect(Object.fromEntries(tricky.byActivity.operating)).toEqual({ "4-1102": 100_000, "4-1201": -30_000 });
  });

  test("opening + net change = closing, and the statement lists each cash account's closing balance", () => {
    const cash = new Map<string, [number, number]>([
      ["1-1101", [100_000, 100_000]],
      ["1-1201", [1_000_000, 1_200_000]],
      ["1-1302", [0, 70_000]],
    ]);
    const statement = buildCashFlowStatement(CHART, allocation, cash, { key: "total", label: "Jumlah" });
    expect(statement.figures).toMatchObject({ openingCash: 1_100_000, closingCash: 1_370_000, netChange: 270_000, byActivity: { operating: -230_000, investing: -1_500_000, financing: 2_000_000, none: 0 } });
    expect(statement.checks.every((check) => check.ok)).toBe(true);
    expect(statement.rows.filter((row) => row.key.startsWith("cash:")).map((row) => [row.accountCode, row.amounts[0]])).toEqual([
      ["1-1101", 100_000],
      ["1-1201", 1_200_000],
      ["1-1302", 70_000],
    ]);
    expect(statement.rows.some((row) => row.key === "none")).toBe(false);
  });
});
