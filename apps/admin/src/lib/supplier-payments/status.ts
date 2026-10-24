import type { ProductionBatchStatus, PurchaseStatus } from "@ammari/db/schema";
import { formatRupiah } from "@ammari/ui/lib";
import { cumulativeValue, toCentiQty } from "@/lib/receipts/valuation";

// Supplier payment status (docs/plans/purchase-payments.md §3). Pure and integer-only: status is
// always DERIVED from the amount due ("tagihan") and the non-voided payments, never stored (P3).

export type PaymentStatus = "no_bill" | "unpaid" | "partial" | "paid" | "overpaid";

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  no_bill: "Tanpa tagihan",
  unpaid: "Belum bayar",
  partial: "DP",
  paid: "Lunas",
  overpaid: "Lebih bayar",
};

export interface PaymentSummary {
  tagihan: number;
  paid: number;
  /** tagihan − paid, never negative. */
  remaining: number;
  /** paid − tagihan when above the bill (a purchase closed/cancelled under its DPs, A4), else 0. */
  overpaid: number;
  status: PaymentStatus;
}

function assertMoney(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${label}: ${value}`);
}

export function summarizePayment(tagihan: number, paid: number): PaymentSummary {
  assertMoney(tagihan, "tagihan");
  assertMoney(paid, "paid amount");
  const remaining = Math.max(0, tagihan - paid);
  const overpaid = Math.max(0, paid - tagihan);
  let status: PaymentStatus;
  if (overpaid > 0) status = "overpaid";
  else if (tagihan === 0) status = "no_bill";
  else if (paid === 0) status = "unpaid";
  else if (paid < tagihan) status = "partial";
  else status = "paid";
  return { tagihan, paid, remaining, overpaid, status };
}

export interface PaymentAmountRow {
  amount: number;
  voided: boolean;
}

/** Σ non-voided payments (P6: a voided payment stays in history but no longer counts). */
export function paidAmount(payments: readonly PaymentAmountRow[]): number {
  let total = 0;
  for (const payment of payments) {
    if (!Number.isSafeInteger(payment.amount) || payment.amount <= 0) throw new Error(`invalid payment amount: ${payment.amount}`);
    if (payment.voided) continue;
    total += payment.amount;
    assertMoney(total, "paid amount");
  }
  return total;
}

export interface PurchaseTagihanLine {
  qtyOrdered: number;
  totalAmount: number;
  /** Net settled quantity on the line (suppliers-goods-receipt §4.2 qtySettled). Read only for a
   * closed document. */
  qtySettled: number;
}

/** §3.1. Open and received documents are due their order total. A short-closed document is due
 * only what was settled, valued with the receipt valuation's own cumulative rounding (A1), so
 * "what a closed purchase is worth" has a single definition. Cancelled means nothing arrived (D19),
 * so nothing is due. */
export function purchaseTagihan(status: PurchaseStatus, lines: readonly PurchaseTagihanLine[]): number {
  let total = 0;
  for (const line of lines) {
    assertMoney(line.totalAmount, "line total");
    if (status === "cancelled") continue;
    if (status === "closed") {
      const settled = toCentiQty(line.qtySettled);
      total += settled === 0n ? 0 : cumulativeValue(line.totalAmount, toCentiQty(line.qtyOrdered), settled);
    } else {
      total += line.totalAmount;
    }
  }
  assertMoney(total, "tagihan");
  return total;
}

/** The one entry point for a purchase document's payment state (detail page, list rows, the
 * record-payment cap): tagihan from §3.1, paid from the non-voided payments. A closed document's
 * tagihan follows its CURRENT settled quantity, so a later receipt reversal on it lowers the bill
 * (the goods did not arrive after all), and a return-to-supplier re-opens it (D18), which brings
 * the full order total back. */
export function purchasePaymentSummary(
  status: PurchaseStatus,
  lines: readonly PurchaseTagihanLine[],
  payments: readonly PaymentAmountRow[],
): PaymentSummary {
  return summarizePayment(purchaseTagihan(status, lines), paidAmount(payments));
}

export interface BatchCostLine {
  supplierId: string | null;
  supplierName: string | null;
  /** production_batch_costs.total (generated column). */
  total: number;
}

export interface BatchPayee {
  /** null groups the lines nobody attributed ("Tanpa pemasok"). */
  supplierId: string | null;
  supplierName: string | null;
  tagihan: number;
}

/** §3.2. Only a posted batch has a tagihan (a draft's lines can still change or be deleted), and
 * it is the service lines only: fabric and accessory consumption are excluded because that
 * material is already owed through the purchase documents that bought it (A2). Grouped per payee
 * in first-appearance order, the supplier name taken from the first line naming that supplier. */
export function batchTagihan(
  status: ProductionBatchStatus,
  lines: readonly BatchCostLine[],
): { total: number; payees: BatchPayee[] } | null {
  if (status !== "posted") return null;
  const payees = new Map<string | null, BatchPayee>();
  let total = 0;
  for (const line of lines) {
    assertMoney(line.total, "cost line total");
    total += line.total;
    const existing = payees.get(line.supplierId);
    if (existing) existing.tagihan += line.total;
    else payees.set(line.supplierId, { supplierId: line.supplierId, supplierName: line.supplierName, tagihan: line.total });
  }
  assertMoney(total, "tagihan");
  return { total, payees: [...payees.values()] };
}

export interface BatchPaymentRow extends PaymentAmountRow {
  supplierId: string | null;
}

/** One summary per payee (P12: the cap applies per payee). A payment naming someone who is not a
 * payee of the batch can't be attributed, so it throws instead of vanishing from the totals. */
export function batchPayeeSummaries(
  payees: readonly BatchPayee[],
  payments: readonly BatchPaymentRow[],
): (BatchPayee & PaymentSummary)[] {
  const known = new Set(payees.map((payee) => payee.supplierId));
  for (const payment of payments) {
    if (!known.has(payment.supplierId)) throw new Error(`payment names a supplier that is not a payee of this batch: ${payment.supplierId}`);
  }
  return payees.map((payee) => ({
    ...payee,
    ...summarizePayment(payee.tagihan, paidAmount(payments.filter((payment) => payment.supplierId === payee.supplierId))),
  }));
}

/** The Indonesian refusal for a new payment of `amount` against `summary`, or null when allowed.
 * A payment may never exceed the remaining balance (P3). */
export function paymentAmountError(amount: number, summary: PaymentSummary): string | null {
  if (!Number.isSafeInteger(amount) || amount <= 0) return "Jumlah harus bilangan bulat lebih dari 0.";
  if (summary.status === "no_bill") return "Tidak ada tagihan untuk dibayar.";
  if (summary.status === "overpaid") return "Pembayaran sudah melebihi tagihan.";
  if (summary.remaining === 0) return "Tagihan ini sudah lunas.";
  if (amount > summary.remaining) return `Jumlah melebihi sisa tagihan (${formatRupiah(summary.remaining)}).`;
  return null;
}
