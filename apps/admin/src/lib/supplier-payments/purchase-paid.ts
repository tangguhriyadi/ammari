import "server-only";
import { asc, eq } from "drizzle-orm";
import { supplierPayments } from "@ammari/db/schema";
import type { Database } from "@/lib/db";
import { paidAmount, type PaymentAmountRow } from "./status";

// The payment rows of one purchase, reduced to what the money rules need. Kept free of
// lib/purchases imports so updatePurchase/closePurchase can use it without an import cycle.
// A caller that decides on the result must hold the purchase row lock (plan §4.6).

/** Every payment of the purchase, voided ones included (`voided: true`). */
export async function getPurchasePaymentAmounts(purchaseId: string, db: Database): Promise<PaymentAmountRow[]> {
  const rows = await db
    .select({ amount: supplierPayments.amount, voidedAt: supplierPayments.voidedAt })
    .from(supplierPayments)
    .where(eq(supplierPayments.purchaseId, purchaseId))
    .orderBy(asc(supplierPayments.createdAt), asc(supplierPayments.id));
  return rows.map((row) => ({ amount: row.amount, voided: row.voidedAt !== null }));
}

export interface PurchasePaidState {
  /** Σ non-voided payments. */
  paid: number;
  /** Any payment row at all, voided included: the payee of a record is history, so even a voided
   * payment pins the purchase's supplier (supplier_payments_purchase_supplier_fk). */
  hasAnyPayment: boolean;
}

export async function getPurchasePaidState(purchaseId: string, db: Database): Promise<PurchasePaidState> {
  const payments = await getPurchasePaymentAmounts(purchaseId, db);
  return { paid: paidAmount(payments), hasAnyPayment: payments.length > 0 };
}
