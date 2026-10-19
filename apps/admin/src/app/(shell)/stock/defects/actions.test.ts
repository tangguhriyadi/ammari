import { describe, expect, test, vi } from "vitest";

const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

const { returnDefectsAction, disposeDefectsAction, reverseDefectMovementAction } = await import("./actions");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const NIL_ID = "00000000-0000-0000-0000-000000000000";
const RETURN_INPUT = { sourceType: "purchase" as const, lineId: NIL_ID, qty: "1", reason: "Tukar", occurredAt: "2026-10-06" };
const DISPOSE_INPUT = {
  sourceType: "production_batch" as const,
  lineId: NIL_ID,
  qty: "1",
  disposalType: "auction" as const,
  proceeds: "50.000",
  note: "Lelang",
  occurredAt: "2026-10-06",
};

// docs/plans/suppliers-goods-receipt.md D10: every defect disposition needs inventory.manage —
// inventory.receive (who records rejects) and production.manage are not enough. A rejected
// permission check throws (Next's forbidden()/redirect()) before any query runs.
describe("defect dispositions require inventory.manage", () => {
  for (const keys of [["inventory.view", "inventory.receive"], ["production.manage", "stock.view", "finance.view_profit"], []]) {
    test(`returnDefectsAction refuses [${keys.join(", ")}]`, async () => {
      getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(keys));
      await expect(returnDefectsAction(RETURN_INPUT)).rejects.toThrow();
    });
    test(`disposeDefectsAction refuses [${keys.join(", ")}]`, async () => {
      getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(keys));
      await expect(disposeDefectsAction(DISPOSE_INPUT)).rejects.toThrow();
    });
    test(`reverseDefectMovementAction refuses [${keys.join(", ")}]`, async () => {
      getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(keys));
      await expect(reverseDefectMovementAction({ movementId: NIL_ID })).rejects.toThrow();
    });
  }

  test("an unauthenticated session is rejected", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(returnDefectsAction(RETURN_INPUT)).rejects.toThrow();
  });
});

describe("input validation (before any query)", () => {
  test("a return needs a reason", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    expect(await returnDefectsAction({ ...RETURN_INPUT, reason: "  " })).toEqual({ ok: false, error: "Alasan wajib diisi." });
  });

  test("a malformed quantity is refused", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    expect(await returnDefectsAction({ ...RETURN_INPUT, qty: "1,5" })).toEqual({ ok: false, error: "Jumlah tidak valid." });
  });

  test("Lelang needs proceeds > 0", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    expect(await disposeDefectsAction({ ...DISPOSE_INPUT, proceeds: "" })).toEqual({ ok: false, error: "Hasil lelang wajib diisi dan lebih dari Rp 0." });
  });

  test("Hibah and Dibuang refuse any proceeds", async () => {
    for (const disposalType of ["donation", "discarded"] as const) {
      getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
      const result = await disposeDefectsAction({ ...DISPOSE_INPUT, disposalType, proceeds: "1.000" });
      expect(result.ok).toBe(false);
    }
  });

  test("a release needs notes", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    expect(await disposeDefectsAction({ ...DISPOSE_INPUT, note: "" })).toEqual({ ok: false, error: "Catatan wajib diisi." });
  });

  test("an unknown disposal type is refused", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    const result = await disposeDefectsAction({ ...DISPOSE_INPUT, disposalType: "sold" as never });
    expect(result).toEqual({ ok: false, error: "Pilih jenis pelepasan." });
  });
});
