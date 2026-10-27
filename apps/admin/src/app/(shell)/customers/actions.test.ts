import { describe, expect, test, vi } from "vitest";

const { getStaffSessionMock, voidVoucherMock, extendVoucherMock, withdrawMock } = vi.hoisted(() => ({
  getStaffSessionMock: vi.fn(),
  voidVoucherMock: vi.fn(),
  extendVoucherMock: vi.fn(),
  withdrawMock: vi.fn(),
}));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));
// The write paths themselves are covered against a real database (packages/commerce
// vouchers/adjustments.test.ts, lib/customers/consent.test.ts); here only the gate in front.
vi.mock("@ammari/commerce/voucher-adjustments", () => ({ voidVoucher: voidVoucherMock, extendVoucher: extendVoucherMock }));
vi.mock("@/lib/customers/consent", async (importOriginal) => ({ ...(await importOriginal<object>()), withdrawPromoConsent: withdrawMock }));

const { extendVoucherAction, voidVoucherAction, withdrawPromoConsentAction } = await import("./actions");

// docs/plans/growth.md §8.1, §9.3: CS may record a promo withdrawal but never void or extend a
// voucher; a role without customers.view reaches none of them.

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const ID = "00000000-0000-4000-8000-000000000001";
const CS = ["overview.view", "orders.view", "orders.manage", "customers.view", "customers.manage", "stock.view"];
const OWNER = ["customers.view", "customers.manage", "vouchers.void"];

describe("permissions", () => {
  test("CS cannot void or extend a voucher", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(CS));
    await expect(voidVoucherAction({ id: ID, reason: "Tes" })).rejects.toThrow();
    await expect(extendVoucherAction({ id: ID, newExpiryDate: "2026-12-01", reason: "Tes" })).rejects.toThrow();
    expect(voidVoucherMock).not.toHaveBeenCalled();
    expect(extendVoucherMock).not.toHaveBeenCalled();
  });

  test("vouchers.void alone, without customers.view, is not enough", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(["vouchers.void"]));
    await expect(voidVoucherAction({ id: ID, reason: "Tes" })).rejects.toThrow();
  });

  test("a promo withdrawal needs customers.manage on top of customers.view", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(["customers.view"]));
    await expect(withdrawPromoConsentAction({ customerId: ID, source: "whatsapp" })).rejects.toThrow();
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(["customers.manage"]));
    await expect(withdrawPromoConsentAction({ customerId: ID, source: "whatsapp" })).rejects.toThrow();
    expect(withdrawMock).not.toHaveBeenCalled();
  });

  test("an unauthenticated session is rejected", async () => {
    getStaffSessionMock.mockResolvedValue(null);
    await expect(withdrawPromoConsentAction({ customerId: ID, source: "whatsapp" })).rejects.toThrow();
    await expect(voidVoucherAction({ id: ID, reason: "Tes" })).rejects.toThrow();
  });

  test("allowed roles reach the write path with their own staff id", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(CS));
    withdrawMock.mockResolvedValueOnce({ id: ID, promoConsentAt: null });
    expect(await withdrawPromoConsentAction({ customerId: ID, source: "other", note: "Telepon" })).toEqual({ ok: true, data: undefined });
    expect(withdrawMock).toHaveBeenCalledWith({ customerId: ID, source: "other", note: "Telepon" }, "staff-1");

    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(OWNER));
    voidVoucherMock.mockResolvedValueOnce({});
    extendVoucherMock.mockResolvedValueOnce({});
    expect(await voidVoucherAction({ id: ID, reason: "Kartu hilang" })).toEqual({ ok: true, data: undefined });
    expect(voidVoucherMock).toHaveBeenCalledWith({ voucherId: ID, reason: "Kartu hilang", actorStaffUserId: "staff-1" });
    expect(await extendVoucherAction({ id: ID, newExpiryDate: "2026-12-01", reason: "Sakit" })).toEqual({ ok: true, data: undefined });
    expect(extendVoucherMock).toHaveBeenCalledWith({ voucherId: ID, newExpiryDate: "2026-12-01", reason: "Sakit", actorStaffUserId: "staff-1" });
  });
});

describe("input validation", () => {
  test("malformed ids and unknown sources are refused before the write path", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(OWNER));
    withdrawMock.mockClear();
    voidVoucherMock.mockClear();
    expect(await withdrawPromoConsentAction({ customerId: ID, source: "sms" as never })).toEqual({ ok: false, error: "Pilih sumber permintaan." });
    expect(await withdrawPromoConsentAction({ customerId: "x", source: "email" })).toEqual({ ok: false, error: "Data tidak ditemukan." });
    expect(await voidVoucherAction({ id: "x", reason: "Tes" })).toEqual({ ok: false, error: "Data tidak ditemukan." });
    expect(withdrawMock).not.toHaveBeenCalled();
    expect(voidVoucherMock).not.toHaveBeenCalled();
  });
});
