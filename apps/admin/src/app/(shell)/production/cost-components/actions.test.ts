import { describe, expect, test, vi } from "vitest";

const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

const { createCostComponentAction, updateCostComponentAction, setCostComponentActiveAction } = await import("./actions");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const NIL_ID = "00000000-0000-0000-0000-000000000000";

describe("cost component actions require finance.view_profit", () => {
  test("createCostComponentAction rejects a session without finance.view_profit (production.manage alone isn't enough)", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["production.manage"]));
    await expect(
      createCostComponentAction({ name: "Test", unit: "pcs", isActive: true, sortOrder: 0 }),
    ).rejects.toThrow();
  });

  test("updateCostComponentAction rejects a session without finance.view_profit", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(
      updateCostComponentAction(NIL_ID, { name: "Test", unit: "pcs", isActive: true, sortOrder: 0 }),
    ).rejects.toThrow();
  });

  test("setCostComponentActiveAction rejects a session without finance.view_profit", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(setCostComponentActiveAction({ id: NIL_ID, isActive: false })).rejects.toThrow();
  });

  test("an unauthenticated session (null) redirects rather than proceeding", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(
      createCostComponentAction({ name: "Test", unit: "pcs", isActive: true, sortOrder: 0 }),
    ).rejects.toThrow();
  });
});
