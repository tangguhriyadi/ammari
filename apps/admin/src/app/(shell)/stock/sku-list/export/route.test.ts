import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PermissionKey } from "@ammari/db/rbac";

const getStaffSession = vi.fn();
const listSkus = vi.fn();

vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: () => getStaffSession() }));
vi.mock("@/lib/stock/sku-list", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stock/sku-list")>();
  return { ...actual, listSkus: (...args: unknown[]) => listSkus(...args) };
});

const { GET } = await import("./route");

function session(permissionKeys: PermissionKey[]) {
  return { staffUser: { id: "staff-1" }, role: { id: "r", key: "owner", name: "Owner" }, permissionKeys };
}

const get = (query = "") => GET(new Request(`http://localhost:3001/stock/sku-list/export${query}`));

beforeEach(() => {
  getStaffSession.mockReset();
  listSkus.mockReset().mockResolvedValue({
    rows: [
      { sku: "POKA-FZ-SAGE-M", productName: "Gamis Poka", colorName: "Sage", size: "M", isActive: true, stockQty: 4 },
      { sku: "KHI-ALLSIZE", productName: "=Khimar", colorName: "Hitam, Pekat", size: "ALLSIZE", isActive: false, stockQty: 0 },
    ],
    truncated: false,
  });
});

describe("GET /stock/sku-list/export", () => {
  test("refuses without a session, and without stock.view, before reading anything", async () => {
    getStaffSession.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    getStaffSession.mockResolvedValue(session(["orders.view", "products.manage"]));
    expect((await get()).status).toBe(403);
    expect(listSkus).not.toHaveBeenCalled();
  });

  test("a CSV download of the filtered rows, formula-safe, never cached", async () => {
    getStaffSession.mockResolvedValue(session(["stock.view"]));
    const response = await get("?q=%20poka%20&status=active");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment; filename="daftar-sku-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(listSkus).toHaveBeenCalledWith({ q: "poka", activeFilter: "active" });
    // The raw bytes start with the UTF-8 BOM; `text()` drops it while decoding, as Excel does.
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const body = await response.text();
    expect(body).toBe("Produk,Warna,Ukuran,SKU,Status,Stok\r\nGamis Poka,Sage,M,POKA-FZ-SAGE-M,Aktif,4\r\n'=Khimar,\"Hitam, Pekat\",All Size,KHI-ALLSIZE,Nonaktif,0\r\n");
  });

  test("an unknown status filter is ignored, not passed on", async () => {
    getStaffSession.mockResolvedValue(session(["stock.view"]));
    await get("?status=deleted");
    expect(listSkus).toHaveBeenCalledWith({ q: undefined, activeFilter: undefined });
  });
});
