import { describe, expect, test, vi } from "vitest";

const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

const { createPurchaseAction, updatePurchaseAction, receivePurchaseAction, closePurchaseAction, reverseReceiptAction, voidPurchaseAction } =
  await import("./actions");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const NIL_ID = "00000000-0000-0000-0000-000000000000";
const PURCHASE_INPUT = {
  supplierId: NIL_ID,
  orderedAt: "2026-10-01",
  lines: [{ itemType: "fabric" as const, itemId: NIL_ID, qtyOrdered: "10", totalAmount: "1.000.000" }],
};
const RECEIVE_INPUT = { purchaseId: NIL_ID, receivedAt: "2026-10-05", lines: [{ purchaseItemId: NIL_ID, qtyAccepted: "1" }] };

// docs/plans/suppliers-goods-receipt.md D10: inventory.manage for documents, closing and
// reversals; inventory.receive for posting a receipt. A rejected permission check throws (Next's
// forbidden()/redirect()) before any query runs.
describe("purchase document actions require inventory.manage", () => {
  test("createPurchaseAction: inventory.view or inventory.receive alone isn't enough", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.view", "inventory.receive"]));
    await expect(createPurchaseAction(PURCHASE_INPUT)).rejects.toThrow();
  });

  test("updatePurchaseAction rejects a session without inventory.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.receive"]));
    await expect(updatePurchaseAction(NIL_ID, PURCHASE_INPUT)).rejects.toThrow();
  });

  test("updatePurchaseAction also needs finance.view_profit (it re-saves every line's total)", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.view", "inventory.manage"]));
    await expect(updatePurchaseAction(NIL_ID, PURCHASE_INPUT)).rejects.toThrow();
  });

  test("closePurchaseAction rejects a receiver without inventory.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.view", "inventory.receive"]));
    await expect(closePurchaseAction({ purchaseId: NIL_ID, reason: "Batal" })).rejects.toThrow();
  });

  test("reverseReceiptAction rejects a receiver without inventory.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.view", "inventory.receive"]));
    await expect(reverseReceiptAction({ receiptId: NIL_ID })).rejects.toThrow();
  });

  test("voidPurchaseAction (legacy) rejects a session without inventory.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(voidPurchaseAction({ type: "fabric", movementId: NIL_ID })).rejects.toThrow();
  });

  test("an unauthenticated session is rejected", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(createPurchaseAction(PURCHASE_INPUT)).rejects.toThrow();
  });
});

describe("receivePurchaseAction requires inventory.receive", () => {
  test("inventory.manage alone is not enough", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.view", "inventory.manage"]));
    await expect(receivePurchaseAction(RECEIVE_INPUT)).rejects.toThrow();
  });

  test("inventory.view alone is not enough", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.view"]));
    await expect(receivePurchaseAction(RECEIVE_INPUT)).rejects.toThrow();
  });
});

describe("input validation", () => {
  test("createPurchaseAction refuses a purchase without a supplier", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    const result = await createPurchaseAction({ ...PURCHASE_INPUT, supplierId: "" });
    expect(result).toEqual({ ok: false, error: "Pilih supplier terlebih dahulu." });
  });

  test("createPurchaseAction refuses an empty line list", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    const result = await createPurchaseAction({ ...PURCHASE_INPUT, lines: [] });
    expect(result.ok).toBe(false);
  });

  test("receivePurchaseAction refuses a malformed quantity", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.receive"]));
    const result = await receivePurchaseAction({ ...RECEIVE_INPUT, lines: [{ purchaseItemId: NIL_ID, qtyAccepted: "1,5" }] });
    expect(result).toEqual({ ok: false, error: "Jumlah diterima tidak valid." });
  });

  test("closePurchaseAction refuses a blank reason", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    const result = await closePurchaseAction({ purchaseId: NIL_ID, reason: "   " });
    expect(result).toEqual({ ok: false, error: "Alasan wajib diisi." });
  });
});
