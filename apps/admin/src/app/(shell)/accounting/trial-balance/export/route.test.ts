import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStaffSession: vi.fn(), getTrialBalance: vi.fn(), recordTrialBalanceDownload: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: mocks.getStaffSession }));
vi.mock("@/lib/accounting/trial-balance", () => ({ getTrialBalance: mocks.getTrialBalance, recordTrialBalanceDownload: mocks.recordTrialBalanceDownload }));

const { GET } = await import("./route");

// Neraca saldo export (Session 4): accounting.view checked in the route itself, before any read;
// every download audited.

const REPORT = {
  range: { from: "2027-01-01", to: "2027-01-31", segmentStart: "2027-01-01", segment: "official", adjusted: false },
  rows: [{ code: "1-1201", name: "Bank utama", type: "asset", isActive: true, openingDebit: 10_000_000, openingCredit: 0, debit: 0, credit: 1_000_000, closingDebit: 9_000_000, closingCredit: 0 }],
  totals: { openingDebit: 10_000_000, openingCredit: 10_000_000, debit: 1_000_000, credit: 1_000_000, closingDebit: 9_000_000, closingCredit: 9_000_000 },
  balanced: true,
  generatedAt: new Date("2027-02-01T03:00:00Z"),
};

function session(permissionKeys: string[]) {
  return { staffUser: { id: "staff-1" }, role: { id: "r", key: "x", name: "X" }, permissionKeys };
}

const get = (query: string) => GET(new Request(`http://localhost:3001/accounting/trial-balance/export?${query}`));

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getTrialBalance.mockResolvedValue(REPORT);
});

describe("GET /accounting/trial-balance/export", () => {
  test("401 without a session, 403 without accounting.view (finance.view_profit is not enough), before any read", async () => {
    mocks.getStaffSession.mockResolvedValue(null);
    expect((await get("format=pdf")).status).toBe(401);
    mocks.getStaffSession.mockResolvedValue(session(["finance.view_profit"]));
    expect((await get("format=pdf")).status).toBe(403);
    expect(mocks.getTrialBalance).not.toHaveBeenCalled();
  });

  test("400 for an unknown format", async () => {
    mocks.getStaffSession.mockResolvedValue(session(["accounting.view"]));
    expect((await get("format=csv")).status).toBe(400);
  });

  test("PDF and Excel downloads, never cached, each audited", async () => {
    mocks.getStaffSession.mockResolvedValue(session(["accounting.view"]));
    const pdf = await get("format=pdf&from=2027-01-01&to=2027-01-31");
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe('attachment; filename="neraca-saldo-2027-01-01-2027-01-31.pdf"');
    expect(pdf.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
    const xlsx = await get("format=xlsx&from=2027-01-01&to=2027-01-31");
    expect(xlsx.status).toBe(200);
    expect(Buffer.from(await xlsx.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");
    expect(mocks.getTrialBalance).toHaveBeenCalledWith({ from: "2027-01-01", to: "2027-01-31" });
    expect(mocks.recordTrialBalanceDownload.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ["staff-1", "pdf"],
      ["staff-1", "xlsx"],
    ]);
  });
});
