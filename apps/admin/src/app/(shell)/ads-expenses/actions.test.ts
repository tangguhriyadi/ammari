import { describe, expect, test, vi } from "vitest";

const { getStaffSessionMock, storePrivateUploadMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn(), storePrivateUploadMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));
// Never reached by these tests; mocked so a regression that stores before validating fails loudly
// instead of writing to a real bucket.
vi.mock("@/lib/supplier-payments/store-upload", () => ({ storePrivateUpload: storePrivateUploadMock }));

// The category read (expense_categories) is covered against the database in
// lib/expense-categories/queries.test.ts and lib/expenses/records.test.ts; here it answers from the
// seed with the same refusal the real one gives for an unknown code, and knows one item
// (ITEM_ID, of "packaging") so the item path can be followed.
const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));
vi.mock("@/lib/expense-categories/queries", async () => {
  const { defaultExpenseCategory } = await import("@/lib/expense-categories/default-catalog");
  const { FieldError } = await import("@/lib/errors");
  selectMock.mockImplementation(async (code: string, itemId: string | null) => {
    let category;
    try {
      category = defaultExpenseCategory(code);
    } catch {
      throw new FieldError("category", "Pilih kategori.");
    }
    if (code === "packaging" && itemId === null) throw new FieldError("itemId", "Pilih item biaya.");
    if (itemId === null) return { category, item: null };
    if (code !== "packaging" || itemId !== ITEM_ID) throw new FieldError("itemId", "Item biaya tidak ditemukan.");
    return { category, item: { id: ITEM_ID, name: "Kardus" } };
  });
  return { getSelectableExpenseCategoryAndItem: selectMock };
});

const { findExpenseProofDuplicatesAction, recordBusinessExpenseAction, voidBusinessExpenseAction } = await import("./actions");

// docs/plans/growth.md §7: every expense action re-checks ads_expenses.manage + finance.view_profit
// on the server, and refuses bad input before touching storage. (The write paths are covered
// against a real database in lib/expenses/records.test.ts.)

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const NIL_ID = "00000000-0000-0000-0000-000000000000";
const EXPENSE_KEYS = ["ads_expenses.manage", "finance.view_profit"];

function recordForm(overrides: Record<string, string | File | null> = {}): FormData {
  const values: Record<string, string | File | null> = {
    expenseDate: "2026-10-02",
    category: "ads_shopee",
    amount: "500.000",
    method: "platform_balance",
    channelId: "shopee",
    campaign: "",
    note: "",
    proof: new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "bukti.jpg", { type: "image/jpeg" }),
    ...overrides,
  };
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) if (value !== null) formData.set(key, value);
  return formData;
}

describe("permissions", () => {
  test("recording needs ads_expenses.manage AND finance.view_profit", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["finance.view_profit", "supplier_payments.manage"]));
    await expect(recordBusinessExpenseAction(recordForm())).rejects.toThrow();
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["ads_expenses.manage"]));
    await expect(recordBusinessExpenseAction(recordForm())).rejects.toThrow();
  });

  test("voiding and the duplicate-proof lookup need the same two keys", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["finance.view_profit"]));
    await expect(voidBusinessExpenseAction({ id: NIL_ID, reason: "Salah" })).rejects.toThrow();
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["customers.view", "orders.view"]));
    await expect(findExpenseProofDuplicatesAction({ sha256: "a".repeat(64) })).rejects.toThrow();
  });

  test("an unauthenticated session is rejected", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(recordBusinessExpenseAction(recordForm())).rejects.toThrow();
  });
});

describe("input validation, before any storage call", () => {
  test("the proof is required, and a file over 10 MB is refused unread", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(EXPENSE_KEYS));
    expect(await recordBusinessExpenseAction(recordForm({ proof: null }))).toEqual({
      ok: false,
      error: "Bukti bayar wajib diunggah.",
      fieldErrors: { proof: "Bukti bayar wajib diunggah." },
    });
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "besar.jpg", { type: "image/jpeg" });
    expect(await recordBusinessExpenseAction(recordForm({ proof: big }))).toMatchObject({ ok: false, error: "Ukuran file maksimal 10 MB." });
  });

  test("category, method, amount, channel and the Lainnya note are refused with Indonesian messages", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(EXPENSE_KEYS));
    expect(await recordBusinessExpenseAction(recordForm({ category: "hadiah" }))).toMatchObject({ ok: false, fieldErrors: { category: "Pilih kategori." } });
    expect(await recordBusinessExpenseAction(recordForm({ method: "cek" }))).toMatchObject({ ok: false, fieldErrors: { method: "Pilih metode pembayaran." } });
    expect(await recordBusinessExpenseAction(recordForm({ amount: "0" }))).toMatchObject({ ok: false, fieldErrors: { amount: expect.any(String) } });
    expect(await recordBusinessExpenseAction(recordForm({ amount: "1,5" }))).toMatchObject({ ok: false, fieldErrors: { amount: expect.any(String) } });
    expect(await recordBusinessExpenseAction(recordForm({ channelId: "tiktok" }))).toMatchObject({ ok: false, fieldErrors: { channelId: expect.stringMatching(/Shopee/) } });
    expect(await recordBusinessExpenseAction(recordForm({ category: "other", channelId: "", method: "cash" }))).toMatchObject({
      ok: false,
      fieldErrors: { note: "Untuk kategori Lainnya, tulis di catatan biaya apa ini." },
    });
    expect(await recordBusinessExpenseAction(recordForm({ expenseDate: "2999-01-01" }))).toMatchObject({ ok: false, fieldErrors: { expenseDate: "Tanggal bayar tidak boleh di masa depan." } });
    expect(storePrivateUploadMock).not.toHaveBeenCalled();
  });

  test("the item: a malformed id, another category's item, and a missing required item are refused before storage", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(EXPENSE_KEYS));
    const packaging = { category: "packaging", channelId: "", method: "cash" };
    expect(await recordBusinessExpenseAction(recordForm({ ...packaging, itemId: "kardus" }))).toMatchObject({ ok: false, fieldErrors: { itemId: "Item biaya tidak ditemukan." } });
    expect(await recordBusinessExpenseAction(recordForm({ itemId: ITEM_ID }))).toMatchObject({ ok: false, fieldErrors: { itemId: "Item biaya tidak ditemukan." } });
    expect(selectMock).toHaveBeenLastCalledWith("ads_shopee", ITEM_ID);
    expect(await recordBusinessExpenseAction(recordForm({ ...packaging, itemId: "" }))).toMatchObject({ ok: false, fieldErrors: { itemId: "Pilih item biaya." } });
    expect(selectMock).toHaveBeenLastCalledWith("packaging", null);
    // No itemId field at all (an older form) is "no item".
    expect(await recordBusinessExpenseAction(recordForm(packaging))).toMatchObject({ ok: false, fieldErrors: { itemId: "Pilih item biaya." } });
    expect(storePrivateUploadMock).not.toHaveBeenCalled();
  });

  test("a void needs a reason", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(EXPENSE_KEYS));
    expect(await voidBusinessExpenseAction({ id: NIL_ID, reason: "   " })).toEqual({ ok: false, error: "Alasan pembatalan wajib diisi." });
  });
});
