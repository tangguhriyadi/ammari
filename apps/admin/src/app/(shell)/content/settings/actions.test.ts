import { describe, expect, test, vi } from "vitest";

const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

const { saveStoreSettingsAction } = await import("./actions");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const VALID = { whatsappNumber: "081234567890", supportEmail: "halo@ammari.id", businessAddress: "Jl. Contoh", returnPolicySummary: "Ringkasan" };

describe("saveStoreSettingsAction requires content.manage, NOT products.manage or settings.manage", () => {
  test("rejects a session holding products.manage but not content.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["products.manage"]));
    await expect(saveStoreSettingsAction(VALID)).rejects.toThrow();
  });

  test("rejects a session holding settings.manage but not content.manage — a different, unrelated settings area", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["settings.manage"]));
    await expect(saveStoreSettingsAction(VALID)).rejects.toThrow();
  });

  test("an unauthenticated session (null) redirects rather than proceeding", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(saveStoreSettingsAction(VALID)).rejects.toThrow();
  });
});

describe("saveStoreSettingsAction validation (never reaches the DB)", () => {
  test("rejects an invalid WhatsApp number", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    const result = await saveStoreSettingsAction({ ...VALID, whatsappNumber: "12345" });
    expect(result.ok).toBe(false);
  });

  test("rejects an invalid email", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    const result = await saveStoreSettingsAction({ ...VALID, supportEmail: "not-an-email" });
    expect(result.ok).toBe(false);
  });
});
