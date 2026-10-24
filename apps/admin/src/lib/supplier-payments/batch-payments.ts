import "server-only";
import { eq } from "drizzle-orm";
import { productionBatchCosts, productionBatches, supplierPayments, type ProductionBatchStatus, type SupplierPaymentMethod } from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, type Database } from "@/lib/db";
import { lockProductionBatchForUpdate } from "@/lib/production/db";
import {
  assertAmountAllowed,
  assertPaidAt,
  insertSupplierPayment,
  listSupplierPayments,
  normalizeNote,
  PAYMENT_MESSAGES,
  type SupplierPaymentRow,
} from "./payment-records";
import { batchPayeeSummaries, batchTagihan, paidAmount, summarizePayment, type BatchPayee, type PaymentSummary } from "./status";
import type { StoredPrivateFile } from "./store-upload";

// Supplier payments against a production batch (docs/plans/purchase-payments.md §3.2, §8,
// session S4). What is due is the batch's posted SERVICE lines only (ongkos jahit, finishing...),
// never fabric or accessories (A2), tracked PER PAYEE (P12): each payment names one payee, and
// the cap is that payee's remaining balance. Only a posted batch can be paid: a draft's lines can
// still change or be deleted. Posted lines are frozen (prevent_posted_batch_cost_mutation), and a
// batch closed early keeps them, so the bill never moves once a payment exists.
//
// Lock order inside every write (plan §4.6, §5.7): the batch row FIRST (lockProductionBatchForUpdate,
// the lock posting and draft edits take), then nextDocumentNumber's advisory lock, then the inserts.

export type BatchPayeeSummary = BatchPayee & PaymentSummary;

export interface BatchPaymentSummary {
  /** Σ over payees. Its status is "Lunas" only once every payee is. */
  overall: PaymentSummary;
  payees: BatchPayeeSummary[];
}

/** The key a payee travels under in a form: its supplier id, or this for the unattributed lines. */
export const NO_SUPPLIER_PAYEE_KEY = "none";

export function payeeKey(supplierId: string | null): string {
  return supplierId ?? NO_SUPPLIER_PAYEE_KEY;
}

type BatchForSummary = { id: string; status: ProductionBatchStatus };

/** §3.2 for one batch, or null for a draft (no tagihan yet). A writer deciding on it must hold the
 * batch row lock. */
export async function computeBatchPaymentSummary(batch: BatchForSummary, db: Database = defaultDb): Promise<BatchPaymentSummary | null> {
  const [lines, payments] = await Promise.all([
    db
      .select({ supplierId: productionBatchCosts.supplierId, supplierName: productionBatchCosts.supplierName, total: productionBatchCosts.total })
      .from(productionBatchCosts)
      .where(eq(productionBatchCosts.productionBatchId, batch.id)),
    db
      .select({ supplierId: supplierPayments.supplierId, amount: supplierPayments.amount, voidedAt: supplierPayments.voidedAt })
      .from(supplierPayments)
      .where(eq(supplierPayments.productionBatchId, batch.id)),
  ]);
  const due = batchTagihan(batch.status, lines);
  if (!due) return null;
  const rows = payments.map((row) => ({ supplierId: row.supplierId, amount: row.amount, voided: row.voidedAt !== null }));
  // A stable order for the page and the payee picker: by name, "Tanpa pemasok" last (lines saved
  // in one statement share created_at, so line order alone is not deterministic).
  const payees = [...due.payees].sort((a, b) =>
    a.supplierName === null || b.supplierName === null
      ? Number(a.supplierName === null) - Number(b.supplierName === null)
      : a.supplierName.localeCompare(b.supplierName, "id"),
  );
  return { overall: summarizePayment(due.total, paidAmount(rows)), payees: batchPayeeSummaries(payees, rows) };
}

export async function getBatchPaymentSummary(batchId: string, db: Database = defaultDb): Promise<BatchPaymentSummary | null> {
  const [batch] = await db
    .select({ id: productionBatches.id, status: productionBatches.status })
    .from(productionBatches)
    .where(eq(productionBatches.id, batchId))
    .limit(1);
  return batch ? computeBatchPaymentSummary(batch, db) : null;
}

export interface RecordBatchPaymentInput {
  productionBatchId: string;
  /** The payee: one of the batch's service-line suppliers, or null for the unattributed lines. */
  supplierId: string | null;
  /** Asia/Jakarta calendar date, YYYY-MM-DD. */
  paidAt: string;
  amount: number;
  method: SupplierPaymentMethod;
  note?: string | null;
}

function payeeOf(summary: BatchPaymentSummary, supplierId: string | null): BatchPayeeSummary {
  // Batch-level refusals first, with their own message: no service lines at all ("Tidak ada
  // tagihan untuk dibayar."), or every payee already settled ("Tagihan ini sudah lunas.").
  assertAmountAllowed(1, summary.overall);
  const payee = summary.payees.find((candidate) => candidate.supplierId === supplierId);
  if (!payee) throw new FieldError("payee", PAYMENT_MESSAGES.payeeUnknown);
  return payee;
}

/** The read-only pre-check the action runs BEFORE processing and storing the proof (§5.7). Not a
 * guard: recordBatchPayment re-checks everything under the lock. */
export async function precheckBatchPayment(input: RecordBatchPaymentInput, db: Database = defaultDb): Promise<void> {
  assertPaidAt(input.paidAt);
  normalizeNote(input.note);
  const [batch] = await db
    .select({ id: productionBatches.id, status: productionBatches.status })
    .from(productionBatches)
    .where(eq(productionBatches.id, input.productionBatchId))
    .limit(1);
  if (!batch) throw new ActionError(PAYMENT_MESSAGES.batchNotFound);
  const summary = await computeBatchPaymentSummary(batch, db);
  if (!summary) throw new ActionError(PAYMENT_MESSAGES.batchNotPosted);
  assertAmountAllowed(input.amount, payeeOf(summary, input.supplierId));
}

/** §8 recordSupplierPayment for a batch. `file` was already processed and stored (§5.7); its row
 * is inserted here, in the same transaction as the payment. The payee's name is the service
 * line's own snapshot, so the payment says what the batch says. */
export async function recordBatchPayment(input: RecordBatchPaymentInput, file: StoredPrivateFile, actorStaffUserId: string, db: Database = defaultDb) {
  assertPaidAt(input.paidAt);
  const note = normalizeNote(input.note);

  return db.transaction(async (tx) => {
    const batch = await lockProductionBatchForUpdate(tx, input.productionBatchId);
    if (!batch) throw new ActionError(PAYMENT_MESSAGES.batchNotFound);
    const before = await computeBatchPaymentSummary(batch, tx);
    if (!before) throw new ActionError(PAYMENT_MESSAGES.batchNotPosted);
    const payee = payeeOf(before, input.supplierId);
    assertAmountAllowed(input.amount, payee);

    const payment = await insertSupplierPayment(
      tx,
      {
        target: { type: "production_batch", productionBatchId: batch.id },
        supplierId: payee.supplierId,
        supplierName: payee.supplierName,
        paidAt: input.paidAt,
        amount: input.amount,
        method: input.method,
        note,
      },
      file,
      actorStaffUserId,
    );
    return {
      payment,
      payee: summarizePayment(payee.tagihan, payee.paid + input.amount),
      overall: summarizePayment(before.overall.tagihan, before.overall.paid + input.amount),
    };
  });
}

/** The batch's payment history (listSupplierPayments: paid date order, voided rows kept). */
export async function listBatchPayments(batchId: string, db: Database = defaultDb): Promise<SupplierPaymentRow[]> {
  return listSupplierPayments(eq(supplierPayments.productionBatchId, batchId), db);
}
