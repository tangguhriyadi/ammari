import { describe, expect, test, vi } from "vitest";

const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

const {
  createAccessoryAction,
  updateAccessoryAction,
  setAccessoryActiveAction,
  recordAccessoryPurchaseAction,
  voidAccessoryPurchaseAction,
  recordAccessoryAdjustmentAction,
} = await import("./actions");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const NIL_ID = "00000000-0000-0000-0000-000000000000";

describe("accessory actions require inventory.manage", () => {
  test("createAccessoryAction rejects a session without inventory.manage (inventory.view alone isn't enough)", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.view"]));
    await expect(createAccessoryAction({ name: "Kancing" })).rejects.toThrow();
  });

  test("updateAccessoryAction rejects a session without inventory.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(updateAccessoryAction(NIL_ID, { name: "Kancing" })).rejects.toThrow();
  });

  test("setAccessoryActiveAction rejects a session without inventory.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(setAccessoryActiveAction({ id: NIL_ID, isActive: false })).rejects.toThrow();
  });

  test("recordAccessoryPurchaseAction rejects a session without inventory.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.view"]));
    await expect(
      recordAccessoryPurchaseAction({ accessoryId: NIL_ID, qty: 10, totalAmountPaid: "10.000", purchasedAt: "2026-01-01" }),
    ).rejects.toThrow();
  });

  test("voidAccessoryPurchaseAction rejects a session without inventory.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(voidAccessoryPurchaseAction({ movementId: NIL_ID })).rejects.toThrow();
  });

  test("recordAccessoryAdjustmentAction rejects a session without inventory.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(recordAccessoryAdjustmentAction({ accessoryId: NIL_ID, deltaQty: -1, reason: "lost" })).rejects.toThrow();
  });

  test("an unauthenticated session (null) redirects rather than proceeding", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(createAccessoryAction({ name: "Kancing" })).rejects.toThrow();
  });
});
