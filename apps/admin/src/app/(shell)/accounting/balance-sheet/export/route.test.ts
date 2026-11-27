import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStaffSession: vi.fn(), getBalanceSheet: vi.fn(), getIncomeStatement: vi.fn(), getCashFlow: vi.fn(), recordStatementDownload: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: mocks.getStaffSession }));
vi.mock("@/lib/accounting/statements", () => ({
  getBalanceSheet: mocks.getBalanceSheet,
  getIncomeStatement: mocks.getIncomeStatement,
  getCashFlow: mocks.getCashFlow,
  recordStatementDownload: mocks.recordStatementDownload,
}));

const balanceSheet = await import("./route");
const incomeStatement = await import("../../income-statement/export/route");
const cashFlow = await import("../../cash-flow/export/route");

// Neraca, Laba rugi and Arus kas exports (Session 10): accounting.view checked in the route itself,
// before any read; the page's own parsers; every download audited; never cached.

const RANGE = { from: "2027-01-01", to: "2027-01-31", segmentStart: "2027-01-01", segment: "official", adjusted: false };
const STATEMENT = {
  columns: [{ key: "total", label: "Jumlah" }],
  rows: [
    { key: "revenue", label: "Penjualan", style: "section", depth: 0, amounts: [null] },
    { key: "4-1102", label: "Penjualan Shopee", style: "account", depth: 1, amounts: [1_000_000], accountCode: "4-1102" },
    { key: "net_income", label: "Laba bersih", style: "total", depth: 0, amounts: [-25_000] },
  ],
  checks: [{ label: "Laba bersih sama", ok: true }],
};
const GENERATED = new Date("2027-02-01T03:00:00Z");

function session(permissionKeys: string[]) {
  return { staffUser: { id: "staff-1" }, role: { id: "r", key: "x", name: "X" }, permissionKeys };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getBalanceSheet.mockResolvedValue({ kind: "balance_sheet", asOf: "2027-01-31", segment: "official", segmentStart: "2027-01-01", comparison: { kind: "opening", asOf: "2027-01-01" }, statement: STATEMENT, generatedAt: GENERATED });
  mocks.getIncomeStatement.mockResolvedValue({ kind: "income_statement", range: RANGE, view: "month", monthsClamped: false, statement: STATEMENT, generatedAt: GENERATED });
  mocks.getCashFlow.mockResolvedValue({ kind: "cash_flow", range: RANGE, statement: STATEMENT, generatedAt: GENERATED });
});

const ROUTES = [
  { name: "Neraca", get: balanceSheet.GET, path: "balance-sheet", query: "date=2027-01-31", loader: mocks.getBalanceSheet, file: "neraca-2027-01-31" },
  { name: "Laba rugi", get: incomeStatement.GET, path: "income-statement", query: "from=2027-01-01&to=2027-01-31&view=month", loader: mocks.getIncomeStatement, file: "laba-rugi-2027-01-01-2027-01-31-per-bulan" },
  { name: "Arus kas", get: cashFlow.GET, path: "cash-flow", query: "from=2027-01-01&to=2027-01-31", loader: mocks.getCashFlow, file: "arus-kas-2027-01-01-2027-01-31" },
];

describe.each(ROUTES)("GET /accounting/$path/export ($name)", (route) => {
  const get = (query: string) => route.get(new Request(`http://localhost:3001/accounting/${route.path}/export?${query}`));

  test("401 without a session, 403 without accounting.view (finance.view_profit is not enough), before any read", async () => {
    mocks.getStaffSession.mockResolvedValue(null);
    expect((await get(`format=pdf&${route.query}`)).status).toBe(401);
    mocks.getStaffSession.mockResolvedValue(session(["finance.view_profit"]));
    expect((await get(`format=pdf&${route.query}`)).status).toBe(403);
    expect(route.loader).not.toHaveBeenCalled();
  });

  test("400 for an unknown format", async () => {
    mocks.getStaffSession.mockResolvedValue(session(["accounting.view"]));
    expect((await get(`format=csv&${route.query}`)).status).toBe(400);
    expect(route.loader).not.toHaveBeenCalled();
  });

  test("PDF and Excel downloads, never cached, each audited", async () => {
    mocks.getStaffSession.mockResolvedValue(session(["accounting.view"]));
    const pdf = await get(`format=pdf&${route.query}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe(`attachment; filename="${route.file}.pdf"`);
    expect(pdf.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
    const xlsx = await get(`format=xlsx&${route.query}`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers.get("content-disposition")).toBe(`attachment; filename="${route.file}.xlsx"`);
    expect(Buffer.from(await xlsx.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");
    expect(mocks.recordStatementDownload.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ["staff-1", "pdf"],
      ["staff-1", "xlsx"],
    ]);
  });
});

test("the routes pass the page's parsed filters to the reports", async () => {
  mocks.getStaffSession.mockResolvedValue(session(["accounting.view"]));
  await balanceSheet.GET(new Request("http://localhost:3001/accounting/balance-sheet/export?format=pdf&date=2027-01-31"));
  expect(mocks.getBalanceSheet).toHaveBeenCalledWith("2027-01-31");
  await incomeStatement.GET(new Request("http://localhost:3001/accounting/income-statement/export?format=pdf&from=2027-01-31&to=2027-01-01&view=bogus"));
  // A reversed range is swapped; an unknown view is the total.
  expect(mocks.getIncomeStatement).toHaveBeenCalledWith({ from: "2027-01-01", to: "2027-01-31" }, "total");
  await cashFlow.GET(new Request("http://localhost:3001/accounting/cash-flow/export?format=xlsx&from=2027-01-01&to=2027-01-31"));
  expect(mocks.getCashFlow).toHaveBeenCalledWith({ from: "2027-01-01", to: "2027-01-31" });
});
