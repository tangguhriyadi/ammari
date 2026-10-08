import { describe, expect, test, vi } from "vitest";

const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

const { adjustStockAction, saveStockCountAction } = await import("./actions");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const NIL_ID = "00000000-0000-0000-0000-000000000000";

describe("stock actions require stock.adjust", () => {
  test("adjustStockAction rejects a session without stock.adjust (stock.view alone isn't enough)", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["stock.view"]));
    await expect(adjustStockAction({ sku: "SKU-1", deltaQty: 1, reason: "recount" })).rejects.toThrow();
  });

  test("saveStockCountAction rejects a session without stock.adjust", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(saveStockCountAction({ productId: NIL_ID, lines: [] })).rejects.toThrow();
  });

  test("an unauthenticated session (null) redirects rather than proceeding", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(adjustStockAction({ sku: "SKU-1", deltaQty: 1, reason: "recount" })).rejects.toThrow();
  });
});
