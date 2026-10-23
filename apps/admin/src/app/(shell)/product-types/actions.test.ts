import { describe, expect, test, vi } from "vitest";

const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

const { createProductTypeAction, updateProductTypeAction, setProductTypeActiveAction } = await import("./actions");
const { createProductAction } = await import("../products/actions");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

// Every assertion below is a REJECTION (403 or a validation result) — none of these calls reaches
// a query, which keeps this file safe: the actions use the real `defaultDb`, not `ammari_test`.
// Happy paths are in lib/product-types/queries.test.ts. Same split as suppliers/actions.test.ts.
describe("product type actions require products.manage", () => {
  test("createProductTypeAction rejects a session without products.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage", "content.manage"]));
    await expect(createProductTypeAction({ code: "KHIMAR", name: "Khimar" })).rejects.toThrow();
  });

  test("updateProductTypeAction rejects a session without products.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(updateProductTypeAction("DRESS", { name: "Gamis" })).rejects.toThrow();
  });

  test("setProductTypeActiveAction rejects a session without products.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["orders.view"]));
    await expect(setProductTypeActiveAction({ code: "DRESS", isActive: false })).rejects.toThrow();
  });

  test("an unauthenticated session (null) redirects rather than proceeding", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(createProductTypeAction({ code: "KHIMAR", name: "Khimar" })).rejects.toThrow();
  });
});

describe("product type input validation", () => {
  test("a code that isn't uppercase letters/digits/underscore starting with a letter is refused", async () => {
    for (const code of ["", "1SET", "KHI-MAR", "KHI MAR", "X".repeat(31)]) {
      getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["products.manage"]));
      const result = await createProductTypeAction({ code, name: "Khimar" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.fieldErrors).toHaveProperty("code");
    }
  });

  test("a blank name is refused with an Indonesian message", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["products.manage"]));
    await expect(createProductTypeAction({ code: "KHIMAR", name: "   " })).resolves.toEqual({
      ok: false,
      error: "Nama jenis produk wajib diisi.",
      fieldErrors: { name: "Nama jenis produk wajib diisi." },
    });
  });

  test("a negative or fractional sort order is refused", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["products.manage"]));
    expect((await createProductTypeAction({ code: "KHIMAR", name: "Khimar", sortOrder: -1 })).ok).toBe(false);
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["products.manage"]));
    expect((await createProductTypeAction({ code: "KHIMAR", name: "Khimar", sortOrder: "1.5" })).ok).toBe(false);
  });

  test("update and toggle refuse a malformed code", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["products.manage"]));
    await expect(updateProductTypeAction("dress", { name: "Gamis" })).resolves.toEqual({ ok: false, error: "Jenis produk tidak ditemukan." });
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["products.manage"]));
    await expect(setProductTypeActiveAction({ code: "not a code", isActive: false })).resolves.toEqual({
      ok: false,
      error: "Jenis produk tidak ditemukan.",
    });
  });
});

describe("createProductAction requires a product type", () => {
  const base = {
    name: "Contoh Gamis Tanpa Jenis",
    code: "TANPAJENIS",
    slug: "contoh-gamis-tanpa-jenis",
    fabricId: "00000000-0000-0000-0000-000000000000",
    closure: "front_zip" as const,
    sizeMode: "sized" as const,
    basePrice: "269.000",
    isActive: true,
    highlights: [],
  };

  test("an empty or missing type is refused before any database write", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["products.manage"]));
    await expect(createProductAction({ ...base, productTypeCode: "" })).resolves.toMatchObject({ ok: false, error: "Pilih jenis produk." });
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["products.manage"]));
    // `as never`: a real client can POST anything to a Server Action.
    await expect(createProductAction(base as never)).resolves.toMatchObject({ ok: false, error: "Pilih jenis produk." });
  });
});
