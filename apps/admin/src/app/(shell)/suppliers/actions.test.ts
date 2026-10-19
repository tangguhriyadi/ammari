import { describe, expect, test, vi } from "vitest";

const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

const { createSupplierAction, updateSupplierAction, setSupplierActiveAction } = await import("./actions");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const NIL_ID = "00000000-0000-0000-0000-000000000000";

// Every assertion below is a REJECTION (403 or a validation result) — none of these calls ever
// reaches a query function, which is what keeps this file safe to run: the actions use the real
// `defaultDb` (pointed at the developer's own database by DATABASE_URL), not the `ammari_test`
// client the lib-level tests use. Happy paths are covered in lib/suppliers/queries.test.ts,
// inside a rolled-back transaction against the test database. Same split
// accessories/actions.test.ts already follows.
describe("supplier actions require inventory.manage", () => {
  test("createSupplierAction rejects a session with inventory.view alone", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.view"]));
    await expect(createSupplierAction({ name: "Toko Laksmi" })).rejects.toThrow();
  });

  test("updateSupplierAction rejects a session without inventory.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(updateSupplierAction(NIL_ID, { name: "Toko Laksmi" })).rejects.toThrow();
  });

  test("setSupplierActiveAction rejects a session without inventory.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.view"]));
    await expect(setSupplierActiveAction({ id: NIL_ID, isActive: false })).rejects.toThrow();
  });

  test("an unauthenticated session (null) redirects rather than proceeding", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(createSupplierAction({ name: "Toko Laksmi" })).rejects.toThrow();
  });
});

describe("supplier input validation", () => {
  test("a blank name is refused with an Indonesian message, before any database write", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    await expect(createSupplierAction({ name: "   " })).resolves.toEqual({ ok: false, error: "Nama pemasok wajib diisi." });
  });

  test("a kind outside SUPPLIER_KINDS is refused, not stored", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    // `as` cast: a real client can POST anything to a Server Action, which is exactly why this
    // is validated server-side rather than trusted from the form's own checkboxes.
    const result = await createSupplierAction({ name: "Toko Laksmi", kinds: ["kain"] as never });
    expect(result.ok).toBe(false);
  });

  test("a duplicated kind is refused", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    const result = await createSupplierAction({ name: "Toko Laksmi", kinds: ["fabric", "fabric"] });
    expect(result).toEqual({ ok: false, error: "Jenis pemasok tidak boleh duplikat." });
  });

  test("setSupplierActiveAction refuses a non-uuid id", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    const result = await setSupplierActiveAction({ id: "not-a-uuid", isActive: false });
    expect(result.ok).toBe(false);
  });
});
