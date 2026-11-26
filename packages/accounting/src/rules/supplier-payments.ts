import type { SupplierPaymentMethod, SupplierPaymentTargetType } from "@ammari/db/schema";
import { jakartaDateOf } from "../dates";
import type { JournalLineDraft } from "../journal";
import { mappedAccount, negateOutcome, resolveOrIssue, type PostingContext, type PostingEvent, type PostingOutcome, type PostingRule } from "./types";

// Supplier payments (docs/plans/accounting.md §4.4 P3/P4, §4.5 R4), Session 2: "without chain".
//   P3 (supplier_payment, id, paid), purchase, dated paid_at:
//     Dr supplier_payable.kind.material (2-1101) / Cr cash.method.<method> [D-17].
//   R4 (supplier_payment, id, paid), production batch, dated paid_at:
//     Dr supplier_payable.kind.service (2-1102), or supplier_payable.kind.no_supplier (2-1103)
//     when the payment has no payee / Cr cash.method.<method>.
//   P4 (supplier_payment, id, void), dated voided_at (Jakarta): the exact negation of P3/R4.
//
// "Without chain": the document chain (§4.4: a payment clears the open utang the receipts built,
// and only the rest becomes 1-1601 Uang muka pembelian; over-payment on a batch → 1-1601) needs
// the receipt (P1) and batch (R1) journals, which arrive in Sessions 7 and 8. Until then the whole
// payment clears utang. Session 7 bumps this rule's version, so every journal it posted is
// re-derived with the chain split (reverse + repost; a closed month's difference lands in the
// first open month, D-23). Every line stays on utang or cash/bank, never an expense (D-14 guard).

export const SUPPLIER_PAYMENT_SOURCE_TYPE = "supplier_payment";

export interface SupplierPaymentSnapshot {
  id: string;
  paymentNo: string;
  targetType: SupplierPaymentTargetType;
  /** purchases.purchase_no or production_batches.batch_no. */
  documentNo: string;
  supplierId: string | null;
  supplierName: string | null;
  /** Jakarta day the money moved. */
  paidAt: string;
  amount: number;
  method: SupplierPaymentMethod;
  voidedAt: Date | null;
}

function payableMappingKey(payment: SupplierPaymentSnapshot): string {
  if (payment.targetType === "purchase") return "supplier_payable.kind.material";
  return payment.supplierId ? "supplier_payable.kind.service" : "supplier_payable.kind.no_supplier";
}

function describe(payment: SupplierPaymentSnapshot): string {
  const payee = payment.supplierName ?? "tanpa pemasok";
  const document = payment.targetType === "purchase" ? "pembelian" : "produksi";
  return `Pembayaran ${document} ${payment.documentNo} ke ${payee} (${payment.paymentNo})`;
}

/** P3/R4's journal. */
export function supplierPaymentPaidOutcome(payment: SupplierPaymentSnapshot, context: PostingContext): PostingOutcome {
  return resolveOrIssue(() => {
    const payable = mappedAccount(context, payableMappingKey(payment), "unmapped_supplier_payable", { targetType: payment.targetType });
    const cash = mappedAccount(context, `cash.method.${payment.method}`, "unmapped_payment_method", { method: payment.method });
    const dimensions = { supplierId: payment.supplierId, cashAccountCode: cash };
    const lines: JournalLineDraft[] = [
      { accountCode: payable, debit: payment.amount, credit: 0, ...dimensions },
      { accountCode: cash, debit: 0, credit: payment.amount, ...dimensions },
    ];
    return { kind: "journal", description: describe(payment), lines };
  });
}

export const supplierPaymentRule: PostingRule<SupplierPaymentSnapshot> = {
  name: "supplier_payment",
  ruleVersion: 1,
  events(payment, context) {
    const key = (sourceEvent: string) => ({ sourceType: SUPPLIER_PAYMENT_SOURCE_TYPE, sourceId: payment.id, sourceEvent });
    // Cut-over (plan §2): same as expenses. P3/R4 before the start lives in the opening balances;
    // P4 is posted only while P3/R4 has an active journal (the runner checks).
    const paid: PostingOutcome = payment.paidAt < context.postingStartDate ? { kind: "none" } : supplierPaymentPaidOutcome(payment, context);
    const events: PostingEvent[] = [{ key: key("paid"), sourceDate: payment.paidAt, outcome: paid }];
    if (payment.voidedAt) {
      events.push({
        key: key("void"),
        sourceDate: jakartaDateOf(payment.voidedAt),
        // Built from the rule, not copied from the stored journal, so a re-map re-derives both.
        outcome: negateOutcome(supplierPaymentPaidOutcome(payment, context), `Pembatalan pembayaran ${payment.paymentNo}`),
        requiresActiveJournalFor: key("paid"),
      });
    }
    return events;
  },
};
