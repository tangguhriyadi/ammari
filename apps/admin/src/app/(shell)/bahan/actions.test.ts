import { describe, expect, test, vi } from "vitest";

// requirePermission() calls getStaffSession() (next/headers-backed, real Better Auth session) —
// mocked here so these tests exercise the actual permission ENFORCEMENT (requirePermission ->
// forbidden()) without needing a real request/cookie/DB session. The underlying DB writes these
// actions would otherwise perform are never reached when the check fails, by construction: the
// mocked session resolves before any query runs.
const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

const { createFabricAction, deleteFabricAction, createFabricColorAction, deleteFabricColorAction } =
  await import("./actions");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

describe("every fabric server action requires products.manage", () => {
  test("createFabricAction rejects a session without products.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(createFabricAction({ name: "Bahan Tanpa Izin" })).rejects.toThrow();
  });

  test("deleteFabricAction rejects a session without products.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(deleteFabricAction("00000000-0000-0000-0000-000000000000")).rejects.toThrow();
  });

  test("createFabricColorAction rejects a session without products.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(
      createFabricColorAction("00000000-0000-0000-0000-000000000000", { name: "Sage" }),
    ).rejects.toThrow();
  });

  test("deleteFabricColorAction rejects a session without products.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(deleteFabricColorAction("00000000-0000-0000-0000-000000000000")).rejects.toThrow();
  });

  test("an unauthenticated session (null) redirects rather than proceeding", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(createFabricAction({ name: "Bahan Tanpa Sesi" })).rejects.toThrow();
  });

  // The success path is intentionally NOT exercised here — see produk/actions.test.ts's doc
  // comment; the DB-level behavior is covered against an injected test db in
  // fabric-queries.test.ts.
});
