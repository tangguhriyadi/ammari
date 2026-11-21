import { describe, expect, test, vi } from "vitest";

// requirePermission() calls getStaffSession() (next/headers-backed, real Better Auth session) —
// mocked here so these tests exercise the actual permission ENFORCEMENT (requirePermission ->
// forbidden()) without needing a real request/cookie/DB session. The underlying DB writes these
// actions would otherwise perform are never reached when the check fails, by construction: the
// mocked session resolves before any query runs.
const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

const {
  createFabricAction,
  deleteFabricAction,
  createFabricColorAction,
  deleteFabricColorAction,
  voidFabricPurchaseAction,
  recordFabricAdjustmentAction,
  reclassifyFabricStockAction,
} = await import("./actions");

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

const NIL_ID = "00000000-0000-0000-0000-000000000000";

describe("fabric stock actions require inventory.manage (not products.manage)", () => {
  test("voidFabricPurchaseAction rejects a session without inventory.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(voidFabricPurchaseAction({ movementId: NIL_ID })).rejects.toThrow();
  });

  test("recordFabricAdjustmentAction rejects a session without inventory.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(recordFabricAdjustmentAction({ fabricId: NIL_ID, fabricColorId: null, deltaQty: -1.5, reason: "damaged" })).rejects.toThrow();
  });

  test("reclassifyFabricStockAction rejects a session without inventory.manage, even with products.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["products.manage", "inventory.view"]));
    await expect(reclassifyFabricStockAction({ fabricId: NIL_ID, fromColorId: null, toColorId: NIL_ID, qty: 1, note: "x" })).rejects.toThrow();
  });

  test("reclassifyFabricStockAction requires a reason before reaching the database", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    await expect(reclassifyFabricStockAction({ fabricId: NIL_ID, fromColorId: null, toColorId: NIL_ID, qty: 1, note: "  " })).resolves.toEqual({
      ok: false,
      error: "Alasan wajib diisi.",
    });
  });

  test("reclassifyFabricStockAction validates the quantity and colours before reaching the database", async () => {
    const base = { fabricId: NIL_ID, fromColorId: null, toColorId: NIL_ID, qty: 1, note: "alasan" };
    for (const [input, error] of [
      [{ ...base, qty: 1.234 }, "Maksimal 2 desimal."],
      [{ ...base, qty: -1 }, "Jumlah harus lebih dari 0."],
      [{ ...base, qty: 100_000_000 }, "Jumlah terlalu besar."],
      [{ ...base, toColorId: "bukan-uuid" }, "Pilih warna tujuan."],
    ] as const) {
      getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
      await expect(reclassifyFabricStockAction(input)).resolves.toEqual({ ok: false, error });
    }
  });
});

