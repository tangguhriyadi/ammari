import { describe, expect, test, vi } from "vitest";

// requirePermission() calls getStaffSession() (next/headers-backed, real Better Auth session) —
// mocked here so these tests exercise the actual permission ENFORCEMENT (requirePermission ->
// forbidden()) without needing a real request/cookie/DB session. The underlying DB writes these
// actions would otherwise perform are never reached when the check fails, by construction: the
// mocked session resolves before any query runs.
const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

const { createProductAction, addVariantsAction, updateProductAction } = await import("./actions");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

describe("every product server action requires products.manage", () => {
  test("createProductAction rejects a session without products.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["orders.view"]));
    await expect(
      createProductAction({
        name: "Contoh Gamis Tanpa Izin",
        code: "NOPERM",
        slug: "contoh-gamis-tanpa-izin",
        fabricId: "00000000-0000-0000-0000-000000000000",
        closure: "front_zip",
        sizeMode: "sized",
        basePrice: "269.000",
        isActive: true,
      }),
    ).rejects.toThrow();
  });

  test("updateProductAction rejects a session without products.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(
      updateProductAction("00000000-0000-0000-0000-000000000000", {
        name: "Contoh Gamis",
        slug: "contoh-gamis",
        fabricId: "00000000-0000-0000-0000-000000000000",
        closure: "front_zip",
        basePrice: "269.000",
        isActive: true,
      }),
    ).rejects.toThrow();
  });

  test("addVariantsAction rejects a session without products.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(
      addVariantsAction({
        productId: "00000000-0000-0000-0000-000000000000",
        selections: [{ fabricColorId: "00000000-0000-0000-0000-000000000000", sizes: ["M"] }],
      }),
    ).rejects.toThrow();
  });

  test("an unauthenticated session (null) redirects rather than proceeding", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(
      createProductAction({
        name: "Contoh Gamis Tanpa Sesi",
        code: "NOSESI",
        slug: "contoh-gamis-tanpa-sesi",
        fabricId: "00000000-0000-0000-0000-000000000000",
        closure: "front_zip",
        sizeMode: "sized",
        basePrice: "269.000",
        isActive: true,
      }),
    ).rejects.toThrow();
  });

  // The success path (a session WITH products.manage) is intentionally NOT exercised here: these
  // actions write through the real default db client, not the `ammari_test` one — that path is
  // instead covered against an injected test db in queries.test.ts. This file only verifies the
  // rejection path, which never reaches the DB at all.
});
