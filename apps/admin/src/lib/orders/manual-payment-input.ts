import { z } from "zod";
import { CASH_BANK_ACCOUNT_CODE_PATTERN, MANUAL_ORDER_PAYMENT_METHODS, type ManualOrderPaymentMethod } from "@ammari/db/schema";

// Cara bayar pesanan manual (docs/plans/accounting.md Session 6, D-3): the shared input rules for
// the order form, "Siap Kirim" on an order waiting for payment, and "Isi cara bayar" on the order
// page. Client-safe (no server imports): the forms show the same messages the server returns.

export const MANUAL_PAYMENT_METHOD_LABELS: Record<ManualOrderPaymentMethod, string> = {
  cash: "Tunai",
  transfer: "Transfer",
  // D-18: "Kartu" is always a debit card.
  card: "Kartu debit",
};

export const MANUAL_PAYMENT_MESSAGES = {
  method: "Pilih cara bayar.",
  account: "Pilih rekening tujuan uang.",
  accountNotAllowed: "Rekening tujuan harus akun Kas atau Bank yang aktif.",
  paidOn: "Isi tanggal bayar.",
  paidOnFuture: "Tanggal bayar tidak boleh setelah hari ini.",
  notManualOrder: "Cara bayar hanya dicatat untuk pesanan manual, bukan pesanan checkout website atau marketplace.",
  notPaidYet: "Pesanan ini masih menunggu bayar. Catat cara bayar lewat tombol Siap Kirim.",
  cancelledBeforePayment: "Pesanan ini dibatalkan sebelum dibayar, jadi tidak ada pembayaran untuk dicatat.",
  required: "Pesanan yang sudah dibayar wajib dicatat cara bayar, rekening tujuan, dan tanggal bayarnya.",
  useConfirmPayment: "Pesanan manual perlu dicatat cara bayarnya saat menjadi Siap Kirim. Isi cara bayar di halaman pesanan.",
  orderNotFound: "Pesanan tidak ditemukan.",
} as const;

const CASH_BANK_CODE = new RegExp(CASH_BANK_ACCOUNT_CODE_PATTERN);

export const manualPaymentSchema = z.object({
  method: z.enum(MANUAL_ORDER_PAYMENT_METHODS, { error: MANUAL_PAYMENT_MESSAGES.method }),
  cashAccountCode: z.string({ error: MANUAL_PAYMENT_MESSAGES.account }).regex(CASH_BANK_CODE, MANUAL_PAYMENT_MESSAGES.account),
  paidOn: z.string({ error: MANUAL_PAYMENT_MESSAGES.paidOn }).date(MANUAL_PAYMENT_MESSAGES.paidOn),
});

export type ManualPaymentInput = z.infer<typeof manualPaymentSchema>;

/** The rules a schema cannot see: the money came in no later than today (Jakarta). */
export function manualPaymentDateProblem(paidOn: string, todayJakarta: string): string | null {
  return paidOn > todayJakarta ? MANUAL_PAYMENT_MESSAGES.paidOnFuture : null;
}

/** A Kas & Bank account staff may pick (D-17): today Kas tunai and Bank utama. */
export interface CashAccountOption {
  code: string;
  name: string;
}

/** What the payment fields need from the server: the active Kas & Bank accounts, and per method
 * the account the accountant mapped it to (the preselected choice; null when unmapped). */
export interface ManualPaymentOptions {
  accounts: CashAccountOption[];
  suggestedAccount: Record<ManualOrderPaymentMethod, string | null>;
}

/** The account preselected when staff pick a method: the method's mapping when it is still in the
 * list, else empty (staff choose). */
export function preselectedAccount(method: ManualOrderPaymentMethod, options: ManualPaymentOptions): string {
  const suggested = options.suggestedAccount[method];
  return suggested && options.accounts.some((account) => account.code === suggested) ? suggested : "";
}

/** The account after a method change: the new method's mapped account when staff had not chosen one
 * themselves (empty, or still the previous method's suggestion); otherwise their choice stays. */
export function accountAfterMethodChange(
  draft: { method: ManualOrderPaymentMethod | ""; cashAccountCode: string },
  method: ManualOrderPaymentMethod | "",
  options: ManualPaymentOptions,
): string {
  const previousSuggestion = draft.method ? preselectedAccount(draft.method, options) : "";
  const chosenByStaff = draft.cashAccountCode !== "" && draft.cashAccountCode !== previousSuggestion;
  if (chosenByStaff) return draft.cashAccountCode;
  return method ? preselectedAccount(method, options) : "";
}
