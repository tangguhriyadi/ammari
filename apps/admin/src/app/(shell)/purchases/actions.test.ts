import { describe, expect, test, vi } from "vitest";

const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

const { recordPurchaseAction, voidPurchaseAction } = await import("./actions");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const NIL_ID = "00000000-0000-0000-0000-000000000000";

describe("purchase actions require inventory.manage", () => {
  test("recordPurchaseAction rejects a session without inventory.manage (inventory.view alone isn't enough)", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.view"]));
    await expect(
      recordPurchaseAction({ type: "fabric", itemId: NIL_ID, qty: "10", totalAmountPaid: "100.000", purchasedAt: "2026-01-01" }),
    ).rejects.toThrow();
  });

  test("recordPurchaseAction rejects an unauthenticated session", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(
      recordPurchaseAction({ type: "accessory", itemId: NIL_ID, qty: 10, totalAmountPaid: "100.000", purchasedAt: "2026-01-01" }),
    ).rejects.toThrow();
  });

  test("voidPurchaseAction rejects a session without inventory.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(voidPurchaseAction({ type: "fabric", movementId: NIL_ID })).rejects.toThrow();
  });
});

describe("recordPurchaseAction input validation", () => {
  test("rejects an accessory purchase with a non-integer qty", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    const result = await recordPurchaseAction({
      type: "accessory",
      itemId: NIL_ID,
      qty: 1.5,
      totalAmountPaid: "10.000",
      purchasedAt: "2026-01-01",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a missing itemId", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    const result = await recordPurchaseAction({
      type: "fabric",
      itemId: "not-a-uuid",
      qty: "10",
      totalAmountPaid: "10.000",
      purchasedAt: "2026-01-01",
    });
    expect(result.ok).toBe(false);
  });
});
