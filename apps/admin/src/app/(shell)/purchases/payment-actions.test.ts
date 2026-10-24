import { describe, expect, test, vi } from "vitest";

const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

const { attachPurchaseInvoiceAction, recordPurchasePaymentAction, voidPurchaseAttachmentAction } = await import("./payment-actions");
const { findDuplicateProofAction, voidSupplierPaymentAction } = await import("@/components/supplier-payments/actions");

// docs/plans/purchase-payments.md §7: every payment action re-checks its permissions on the
// server, and refuses bad input before touching the database or storage. (The write paths
// themselves are covered against a real database in lib/supplier-payments/purchase-payments.test.ts.)

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const NIL_ID = "00000000-0000-0000-0000-000000000000";
const PAYMENT_KEYS = ["supplier_payments.manage", "finance.view_profit"];

function recordForm(overrides: Record<string, string | File | null> = {}): FormData {
  const values: Record<string, string | File | null> = {
    purchaseId: NIL_ID,
    paidAt: "2026-10-02",
    amount: "300.000",
    method: "transfer",
    note: "",
    proof: new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "bukti.jpg", { type: "image/jpeg" }),
    ...overrides,
  };
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) if (value !== null) formData.set(key, value);
  return formData;
}

describe("permissions", () => {
  test("recording needs supplier_payments.manage AND finance.view_profit", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["finance.view_profit", "inventory.manage", "inventory.view"]));
    await expect(recordPurchasePaymentAction(recordForm())).rejects.toThrow();
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["supplier_payments.manage", "inventory.view"]));
    await expect(recordPurchasePaymentAction(recordForm())).rejects.toThrow();
  });

  test("voiding a payment and the duplicate-proof lookup need the same two keys", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["finance.view_profit"]));
    await expect(voidSupplierPaymentAction({ id: NIL_ID, reason: "Salah" })).rejects.toThrow();
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.view", "inventory.manage"]));
    await expect(findDuplicateProofAction({ sha256: "a".repeat(64) })).rejects.toThrow();
  });

  test("a nota needs inventory.manage AND finance.view_profit", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage", "inventory.view"]));
    await expect(attachPurchaseInvoiceAction(new FormData())).rejects.toThrow();
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["supplier_payments.manage", "finance.view_profit"]));
    await expect(voidPurchaseAttachmentAction({ id: NIL_ID, reason: "Salah" })).rejects.toThrow();
  });

  test("an unauthenticated session is rejected", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(recordPurchasePaymentAction(recordForm())).rejects.toThrow();
  });
});

describe("input validation, before any database or storage call", () => {
  test("the proof is required", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(PAYMENT_KEYS));
    expect(await recordPurchasePaymentAction(recordForm({ proof: null }))).toEqual({
      ok: false,
      error: "Bukti bayar wajib diunggah.",
      fieldErrors: { proof: "Bukti bayar wajib diunggah." },
    });
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(PAYMENT_KEYS));
    const empty = await recordPurchasePaymentAction(recordForm({ proof: new File([], "kosong.jpg", { type: "image/jpeg" }) }));
    expect(empty).toMatchObject({ ok: false, error: "Bukti bayar wajib diunggah." });
  });

  test("a file over 10 MB is refused without being read", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(PAYMENT_KEYS));
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "besar.jpg", { type: "image/jpeg" });
    expect(await recordPurchasePaymentAction(recordForm({ proof: big }))).toMatchObject({ ok: false, error: "Ukuran file maksimal 10 MB." });
  });

  test("amount, method and date are validated with Indonesian messages", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(PAYMENT_KEYS));
    expect(await recordPurchasePaymentAction(recordForm({ amount: "0" }))).toMatchObject({ ok: false, error: "Jumlah harus bilangan bulat lebih dari 0." });
    expect(await recordPurchasePaymentAction(recordForm({ amount: "1,5" }))).toMatchObject({ ok: false, fieldErrors: { amount: expect.any(String) } });
    expect(await recordPurchasePaymentAction(recordForm({ method: "cek" }))).toMatchObject({ ok: false, error: "Pilih metode pembayaran." });
    expect(await recordPurchasePaymentAction(recordForm({ paidAt: "kemarin" }))).toMatchObject({ ok: false, error: "Tanggal bayar tidak valid." });
    expect(await recordPurchasePaymentAction(recordForm({ note: "x".repeat(501) }))).toMatchObject({ ok: false, error: "Catatan maksimal 500 karakter." });
    getStaffSessionMock.mockReset();
  });

  test("voiding needs a reason", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(PAYMENT_KEYS));
    expect(await voidSupplierPaymentAction({ id: NIL_ID, reason: "   " })).toEqual({ ok: false, error: "Alasan pembatalan wajib diisi." });
  });

  test("a nota file is required", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage", "finance.view_profit"]));
    const formData = new FormData();
    formData.set("purchaseId", NIL_ID);
    expect(await attachPurchaseInvoiceAction(formData)).toMatchObject({ ok: false, error: "File nota wajib dipilih." });
  });

  test("a malformed hash finds nothing instead of querying", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(PAYMENT_KEYS));
    expect(await findDuplicateProofAction({ sha256: "zz" })).toEqual({ ok: true, data: { paymentNos: [] } });
  });
});
