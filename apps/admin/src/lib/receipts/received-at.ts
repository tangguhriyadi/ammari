import { FieldError } from "@/lib/errors";
import { todayInJakarta } from "@/lib/products/jakarta-date";

/** A receipt's date (D21): a Jakarta calendar date, defaulting to today in the form, backdatable,
 * never in the future. Shared by purchase and production receipts. */
export function assertReceivedAt(receivedAt: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedAt)) throw new FieldError("receivedAt", "Tanggal terima tidak valid.");
  if (receivedAt > todayInJakarta()) throw new FieldError("receivedAt", "Tanggal terima tidak boleh di masa depan.");
}
