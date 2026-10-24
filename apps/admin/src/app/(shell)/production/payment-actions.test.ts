import { describe, expect, test, vi } from "vitest";

const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

const { recordBatchPaymentAction } = await import("./payment-actions");

// docs/plans/purchase-payments.md §7, session S4: the batch payment action re-checks its
// permissions on the server and refuses bad input before touching the database or storage. (The
// write path itself is covered against a real database in lib/supplier-payments/batch-payments.test.ts.)

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const NIL_ID = "00000000-0000-0000-0000-000000000000";
const PAYMENT_KEYS = ["supplier_payments.manage", "finance.view_profit", "production.manage"];

function recordForm(overrides: Record<string, string | File | null> = {}): FormData {
  const values: Record<string, string | File | null> = {
    productionBatchId: NIL_ID,
    payee: NIL_ID,
    paidAt: "2026-10-02",
    amount: "100.000",
    method: "cash",
    note: "",
    proof: new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "bukti.jpg", { type: "image/jpeg" }),
    ...overrides,
  };
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) if (value !== null) formData.set(key, value);
  return formData;
}

describe("recordBatchPaymentAction", () => {
  test("needs supplier_payments.manage AND finance.view_profit (production.manage alone is not enough)", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["production.manage", "finance.view_profit"]));
    await expect(recordBatchPaymentAction(recordForm())).rejects.toThrow();
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["production.manage", "supplier_payments.manage"]));
    await expect(recordBatchPaymentAction(recordForm())).rejects.toThrow();
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(recordBatchPaymentAction(recordForm())).rejects.toThrow();
  });

  test("the payee must be a supplier id or the 'Tanpa pemasok' key", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(PAYMENT_KEYS));
    expect(await recordBatchPaymentAction(recordForm({ payee: null }))).toMatchObject({ ok: false, fieldErrors: { payee: "Pilih penerima pembayaran." } });
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(PAYMENT_KEYS));
    expect(await recordBatchPaymentAction(recordForm({ payee: "penjahit" }))).toMatchObject({ ok: false, fieldErrors: { payee: "Pilih penerima pembayaran." } });
  });

  test("the proof is required and the shared field rules apply", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(PAYMENT_KEYS));
    expect(await recordBatchPaymentAction(recordForm({ proof: null }))).toMatchObject({ ok: false, fieldErrors: { proof: "Bukti bayar wajib diunggah." } });
    expect(await recordBatchPaymentAction(recordForm({ amount: "0" }))).toMatchObject({ ok: false, error: "Jumlah harus bilangan bulat lebih dari 0." });
    expect(await recordBatchPaymentAction(recordForm({ productionBatchId: "x" }))).toMatchObject({ ok: false, error: "Batch produksi tidak ditemukan." });
    getStaffSessionMock.mockReset();
  });
});
