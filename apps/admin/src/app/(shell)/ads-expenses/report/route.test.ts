import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PermissionKey } from "@ammari/db/rbac";

// "Unduh laporan bulanan" (docs/plans/growth.md session S6, owner addition A): refused without
// ads_expenses.manage + finance.view_profit before anything is read or audited; the period is
// parsed exactly as the Ringkasan tab parses it; every download is audited.

const getStaffSession = vi.fn();
const getMonthlyReport = vi.fn();
const recordMonthlyReportDownload = vi.fn();
const renderPdf = vi.fn();
const renderXlsx = vi.fn();

vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: () => getStaffSession() }));
vi.mock("@/lib/expenses/report", () => ({
  getMonthlyReport: (...args: unknown[]) => getMonthlyReport(...args),
  recordMonthlyReportDownload: (...args: unknown[]) => recordMonthlyReportDownload(...args),
}));
vi.mock("@/lib/expenses/report-pdf", () => ({ loadReportLogo: async () => null, renderMonthlyReportPdf: (...args: unknown[]) => renderPdf(...args) }));
vi.mock("@/lib/expenses/report-xlsx", () => ({ renderMonthlyReportXlsx: (...args: unknown[]) => renderXlsx(...args) }));

const { GET } = await import("./route");

function session(permissionKeys: PermissionKey[]) {
  return { staffUser: { id: "staff-1" }, role: { id: "r", key: "finance", name: "Keuangan" }, permissionKeys };
}

const get = (query: string) => GET(new Request(`http://localhost:3001/ads-expenses/report${query}`));
const REPORT = { params: {}, summary: {}, expenseRows: [], orderRows: [], ordersTruncated: false };

beforeEach(() => {
  getStaffSession.mockReset();
  getMonthlyReport.mockReset().mockResolvedValue(REPORT);
  recordMonthlyReportDownload.mockReset().mockResolvedValue(undefined);
  renderPdf.mockReset().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  renderXlsx.mockReset().mockReturnValue(new Uint8Array([0x50, 0x4b]));
});

describe("GET /ads-expenses/report", () => {
  test("401 without a session; 403 with only one of the two keys (CS has neither); nothing read or audited", async () => {
    getStaffSession.mockResolvedValue(null);
    expect((await get("?format=pdf")).status).toBe(401);
    for (const keys of [["ads_expenses.manage"], ["finance.view_profit"], ["customers.view", "customers.manage"]] as PermissionKey[][]) {
      getStaffSession.mockResolvedValue(session(keys));
      expect((await get("?format=pdf")).status).toBe(403);
    }
    expect(getMonthlyReport).not.toHaveBeenCalled();
    expect(recordMonthlyReportDownload).not.toHaveBeenCalled();
  });

  test("an unknown format is refused before reading", async () => {
    getStaffSession.mockResolvedValue(session(["ads_expenses.manage", "finance.view_profit"]));
    expect((await get("?format=csv")).status).toBe(400);
    expect((await get("")).status).toBe(400);
    expect(getMonthlyReport).not.toHaveBeenCalled();
  });

  test("PDF for one month: the parsed period, attachment headers, audited after the file is built", async () => {
    getStaffSession.mockResolvedValue(session(["ads_expenses.manage", "finance.view_profit"]));
    const response = await get("?format=pdf&period=month&month=2026-02");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="laporan-keuangan-2026-02.pdf"');
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(getMonthlyReport.mock.calls[0]![0]).toMatchObject({ period: "month", fromMonth: "2026-02", toMonth: "2026-02", range: { from: "2026-02-01", to: "2026-02-28" }, invalid: false });
    expect(recordMonthlyReportDownload).toHaveBeenCalledWith("staff-1", REPORT, "pdf");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  });

  test("Excel for a month range; a future range falls back to this month as on screen", async () => {
    getStaffSession.mockResolvedValue(session(["ads_expenses.manage", "finance.view_profit"]));
    const response = await get("?format=xlsx&period=range&from=2026-01&to=2026-03");
    expect(response.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="laporan-keuangan-2026-01-sd-2026-03.xlsx"');
    expect(recordMonthlyReportDownload).toHaveBeenCalledWith("staff-1", REPORT, "xlsx");

    await get("?format=xlsx&period=range&from=2099-01&to=2099-02");
    expect(getMonthlyReport.mock.calls[1]![0]).toMatchObject({ invalid: true });
  });

  test("a failed render is not audited", async () => {
    getStaffSession.mockResolvedValue(session(["ads_expenses.manage", "finance.view_profit"]));
    renderPdf.mockRejectedValue(new Error("boom"));
    await expect(get("?format=pdf")).rejects.toThrow("boom");
    expect(recordMonthlyReportDownload).not.toHaveBeenCalled();
  });
});
