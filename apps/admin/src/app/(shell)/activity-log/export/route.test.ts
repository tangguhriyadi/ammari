import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PermissionKey } from "@ammari/db/rbac";
import type { ActivityLogRow } from "@/lib/activity-log/queries";

const getStaffSession = vi.fn();
const exportActivityLogRows = vi.fn();
const recordActivityLogExport = vi.fn();

vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: () => getStaffSession() }));
vi.mock("@/lib/activity-log/queries", () => ({
  EXPORT_ROW_CAP: 5000,
  exportActivityLogRows: (...args: unknown[]) => exportActivityLogRows(...args),
  recordActivityLogExport: (...args: unknown[]) => recordActivityLogExport(...args),
}));

const { GET } = await import("./route");

function session(permissionKeys: PermissionKey[]) {
  return { staffUser: { id: "staff-1" }, role: { id: "r", key: "super_admin", name: "Super Admin" }, permissionKeys };
}

const get = (query = "") => GET(new Request(`http://localhost:3001/activity-log/export${query}`));

const ROW: ActivityLogRow = {
  id: "a1",
  createdAt: new Date("2026-10-27T03:15:00Z"),
  action: "transition_status",
  entityType: "order",
  entityId: "0b5f6d0e-2c1a-4c38-9d7e-1f2a3b4c5d6e",
  actionLabel: "Status pesanan diubah",
  area: "orders",
  areaLabel: "Pesanan",
  actor: { kind: "staff", id: "s1", name: "Rina", email: "rina@example.test" },
  entity: { typeLabel: "Pesanan", label: "=ORD-1", href: "/orders/x" },
};

beforeEach(() => {
  getStaffSession.mockReset();
  exportActivityLogRows.mockReset().mockResolvedValue({ rows: [ROW, { ...ROW, id: "a2", actor: { kind: "buyer", label: "Pembeli" } }], truncated: false });
  recordActivityLogExport.mockReset().mockResolvedValue(undefined);
});

describe("GET /activity-log/export", () => {
  test("refuses without a session, and without audit_log.view (owner), before reading or auditing anything", async () => {
    getStaffSession.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    getStaffSession.mockResolvedValue(session(["orders.view", "staff.manage", "finance.view_profit"]));
    expect((await get()).status).toBe(403);
    expect(exportActivityLogRows).not.toHaveBeenCalled();
    expect(recordActivityLogExport).not.toHaveBeenCalled();
  });

  test("a CSV of the filtered rows, formula-safe, never cached, and the download is audited", async () => {
    getStaffSession.mockResolvedValue(session(["audit_log.view"]));
    const response = await get("?from=2026-10-01&to=2026-10-27&area=orders&q=%20ORD-1%20&actor=bogus");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment; filename="log-aktivitas-2026-10-01-sd-2026-10-27-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(response.headers.get("Cache-Control")).toContain("no-store");

    const filters = { from: "2026-10-01", to: "2026-10-27", area: "orders", q: "ORD-1" };
    expect(exportActivityLogRows).toHaveBeenCalledWith(filters, 5000);
    expect(recordActivityLogExport).toHaveBeenCalledWith("staff-1", filters, 2, false);

    const lines = (await response.text()).trimEnd().split("\r\n");
    expect(lines[0]).toBe("Waktu (WIB),Pelaku,Email pelaku,Aktivitas,Bagian,Jenis data,Data,Kode aktivitas,ID data");
    expect(lines[1]).toBe(`"27 Okt 2026, 10.15",Rina,rina@example.test,Status pesanan diubah,Pesanan,Pesanan,'=ORD-1,order/transition_status,0b5f6d0e-2c1a-4c38-9d7e-1f2a3b4c5d6e`);
    expect(lines[2]).toContain(",Pembeli,,");
    expect(lines).toHaveLength(3);
  });

  test("a truncated export says so in its last line", async () => {
    getStaffSession.mockResolvedValue(session(["audit_log.view"]));
    exportActivityLogRows.mockResolvedValue({ rows: [ROW], truncated: true });
    const text = await (await get()).text();
    expect(text.trimEnd().split("\r\n").at(-1)).toBe("Dipotong: hanya 5000 baris terbaru. Persempit tanggal atau filter untuk sisanya.");
    expect(recordActivityLogExport).toHaveBeenCalledWith("staff-1", expect.anything(), 1, true);
  });
});
