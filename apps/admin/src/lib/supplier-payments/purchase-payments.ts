import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { privateFiles, purchaseAttachments, purchaseItems, purchases, staffUsers, supplierPayments, suppliers, type PurchaseStatus, type SupplierPaymentMethod } from "@ammari/db/schema";
import { ActionError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { getLineQuantities, lockPurchaseForUpdate } from "@/lib/purchases/queries";
import {
  assertAmountAllowed,
  assertPaidAt,
  insertSupplierPayment,
  listSupplierPayments,
  normalizeNote,
  normalizeReason,
  PAYMENT_MESSAGES,
  privateFileValues,
  type PrivateFileRef,
  type SupplierPaymentRow,
} from "./payment-records";
import { getPurchasePaymentAmounts } from "./purchase-paid";
import { purchasePaymentSummary, summarizePayment, type PaymentSummary } from "./status";
import type { StoredPrivateFile } from "./store-upload";

// Supplier payments against a purchase document, and the supplier's nota attached to it
// (docs/plans/purchase-payments.md §8, session S3). Append-only: a payment or a nota is never
// edited or deleted, only voided once with a reason (P6; the 0038 triggers are the backstop).
//
// Lock order inside every write (plan §4.6, §5.7): the purchase row FIRST (the same lock edits,
// receipts, returns and closing take, so the balance cap is never a check-then-write race), then
// nextDocumentNumber's advisory lock, then the inserts. The private_files row is inserted only
// here, after the cap check, never in a separate transaction: rows are undeletable, so an orphan
// row could never be cleaned up.

// ---------- Summary ----------

type PurchaseForSummary = Pick<typeof purchases.$inferSelect, "id" | "status">;

/** §3.1 for one purchase: tagihan from its lines (a closed document only for what was settled,
 * A1), paid from its non-voided payments. A writer deciding on it must hold the row lock. */
export async function computePurchasePaymentSummary(purchase: PurchaseForSummary, db: Database = defaultDb): Promise<PaymentSummary> {
  const [lines, payments] = await Promise.all([
    db
      .select({ id: purchaseItems.id, qtyOrdered: purchaseItems.qtyOrdered, totalAmount: purchaseItems.totalAmount })
      .from(purchaseItems)
      .where(eq(purchaseItems.purchaseId, purchase.id)),
    getPurchasePaymentAmounts(purchase.id, db),
  ]);
  // Settled quantities matter only for a short-closed document.
  const quantities = purchase.status === "closed" ? await getLineQuantities(purchase.id, db) : new Map<string, { settled: number }>();
  return purchasePaymentSummary(
    purchase.status,
    lines.map((line) => ({ qtyOrdered: line.qtyOrdered, totalAmount: line.totalAmount, qtySettled: quantities.get(line.id)?.settled ?? 0 })),
    payments,
  );
}

export async function getPurchasePaymentSummary(purchaseId: string, db: Database = defaultDb): Promise<PaymentSummary | null> {
  const [purchase] = await db.select({ id: purchases.id, status: purchases.status }).from(purchases).where(eq(purchases.id, purchaseId)).limit(1);
  return purchase ? computePurchasePaymentSummary(purchase, db) : null;
}

/** What closing the document now would leave due, for the close dialog's "Lebih bayar" warning
 * (§3.1: closing is about goods, so it is still allowed). `null` when closing would not overpay. */
export async function overpaidIfClosed(
  purchaseId: string,
  closingStatus: Extract<PurchaseStatus, "closed" | "cancelled">,
  db: Database = defaultDb,
): Promise<number | null> {
  const summary = await computePurchasePaymentSummary({ id: purchaseId, status: closingStatus }, db);
  return summary.overpaid > 0 ? summary.overpaid : null;
}

export async function purchaseExists(purchaseId: string, db: Database = defaultDb): Promise<boolean> {
  const [row] = await db.select({ id: purchases.id }).from(purchases).where(eq(purchases.id, purchaseId)).limit(1);
  return row !== undefined;
}

// ---------- Validation ----------

export interface RecordPurchasePaymentInput {
  purchaseId: string;
  /** Asia/Jakarta calendar date, YYYY-MM-DD. */
  paidAt: string;
  amount: number;
  method: SupplierPaymentMethod;
  note?: string | null;
}

/** The read-only pre-check the action runs BEFORE processing and storing the proof (§5.7), so a
 * payment that would be refused anyway rarely leaves an unreferenced object behind. Not a guard:
 * recordPurchasePayment re-checks everything under the lock. */
export async function precheckPurchasePayment(input: RecordPurchasePaymentInput, db: Database = defaultDb): Promise<void> {
  assertPaidAt(input.paidAt);
  normalizeNote(input.note);
  const [purchase] = await db.select({ id: purchases.id, status: purchases.status }).from(purchases).where(eq(purchases.id, input.purchaseId)).limit(1);
  if (!purchase) throw new ActionError(PAYMENT_MESSAGES.purchaseNotFound);
  if (purchase.status === "cancelled") throw new ActionError(PAYMENT_MESSAGES.cancelled);
  assertAmountAllowed(input.amount, await computePurchasePaymentSummary(purchase, db));
}

// ---------- Writes ----------

/** §8 recordSupplierPayment for a purchase. `file` was already processed and stored (§5.7); its
 * row is inserted here, in the same transaction as the payment. */
export async function recordPurchasePayment(
  input: RecordPurchasePaymentInput,
  file: StoredPrivateFile,
  actorStaffUserId: string,
  db: Database = defaultDb,
) {
  assertPaidAt(input.paidAt);
  const note = normalizeNote(input.note);

  return db.transaction(async (tx) => {
    const purchase = await lockPurchaseForUpdate(tx, input.purchaseId);
    if (!purchase) throw new ActionError(PAYMENT_MESSAGES.purchaseNotFound);
    if (purchase.status === "cancelled") throw new ActionError(PAYMENT_MESSAGES.cancelled);
    const before = await computePurchasePaymentSummary(purchase, tx);
    assertAmountAllowed(input.amount, before);

    const [supplier] = await tx.select({ name: suppliers.name }).from(suppliers).where(eq(suppliers.id, purchase.supplierId));
    if (!supplier) throw new Error(`supplier ${purchase.supplierId} of purchase ${purchase.id} not found`);
    const payment = await insertSupplierPayment(
      tx,
      {
        target: { type: "purchase", purchaseId: purchase.id },
        supplierId: purchase.supplierId,
        supplierName: supplier.name,
        paidAt: input.paidAt,
        amount: input.amount,
        method: input.method,
        note,
      },
      file,
      actorStaffUserId,
    );
    return { payment, summary: summarizePayment(before.tagihan, before.paid + input.amount) };
  });
}

export interface AttachPurchaseInvoiceInput {
  purchaseId: string;
  note?: string | null;
}

/** §8 attachPurchaseInvoice: the supplier's nota, optional and never blocking anything (P13).
 * Allowed on every status: a nota can arrive after the document was closed. */
export async function attachPurchaseInvoice(
  input: AttachPurchaseInvoiceInput,
  file: StoredPrivateFile,
  actorStaffUserId: string,
  db: Database = defaultDb,
) {
  const note = normalizeNote(input.note);
  if (file.purpose !== "purchase_invoice") throw new Error(`expected a purchase_invoice file, got ${file.purpose}`);

  return db.transaction(async (tx) => {
    const purchase = await lockPurchaseForUpdate(tx, input.purchaseId);
    if (!purchase) throw new ActionError(PAYMENT_MESSAGES.purchaseNotFound);
    const [fileRow] = await tx.insert(privateFiles).values(privateFileValues(file, actorStaffUserId)).returning();
    if (!fileRow) throw new Error("failed to insert private file");
    const [attachment] = await tx
      .insert(purchaseAttachments)
      .values({ purchaseId: purchase.id, kind: "invoice", fileId: fileRow.id, note, createdByStaffUserId: actorStaffUserId })
      .returning();
    if (!attachment) throw new Error("failed to insert purchase attachment");
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "attach",
      entityType: "purchase_attachment",
      entityId: attachment.id,
      after: { attachment, file: fileRow },
    });
    return attachment;
  });
}

export async function voidPurchaseAttachment(attachmentId: string, reason: string, actorStaffUserId: string, db: Database = defaultDb) {
  const trimmed = normalizeReason(reason);

  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(purchaseAttachments).where(eq(purchaseAttachments.id, attachmentId));
    if (!target) throw new ActionError(PAYMENT_MESSAGES.attachmentNotFound);
    // The FK guarantees the purchase exists; the lock only orders this write (plan §4.6).
    if (!(await lockPurchaseForUpdate(tx, target.purchaseId))) throw new Error(`purchase ${target.purchaseId} not found`);

    const [attachment] = await tx
      .update(purchaseAttachments)
      .set({ voidedAt: new Date(), voidedByStaffUserId: actorStaffUserId, voidReason: trimmed })
      .where(and(eq(purchaseAttachments.id, attachmentId), isNull(purchaseAttachments.voidedAt)))
      .returning();
    if (!attachment) throw new ActionError(PAYMENT_MESSAGES.attachmentAlreadyVoided);

    await writeAuditLog(tx, { actorStaffUserId, action: "void", entityType: "purchase_attachment", entityId: attachmentId, before: target, after: attachment });
    return attachment;
  });
}

// ---------- Reads for the detail page ----------

export interface PurchaseAttachmentRow {
  id: string;
  note: string | null;
  createdByName: string | null;
  createdAt: Date;
  file: PrivateFileRef;
  voidedAt: Date | null;
  voidedByName: string | null;
  voidReason: string | null;
}

/** The purchase's payment history (listSupplierPayments: paid date order, voided rows kept). */
export async function listPurchasePayments(purchaseId: string, db: Database = defaultDb): Promise<SupplierPaymentRow[]> {
  return listSupplierPayments(eq(supplierPayments.purchaseId, purchaseId), db);
}

export async function listPurchaseAttachments(purchaseId: string, db: Database = defaultDb): Promise<PurchaseAttachmentRow[]> {
  const createdBy = alias(staffUsers, "created_by");
  const voidedBy = alias(staffUsers, "voided_by");
  const rows = await db
    .select({
      id: purchaseAttachments.id,
      note: purchaseAttachments.note,
      createdByName: createdBy.name,
      createdAt: purchaseAttachments.createdAt,
      fileId: privateFiles.id,
      fileContentType: privateFiles.contentType,
      fileName: privateFiles.originalFilename,
      voidedAt: purchaseAttachments.voidedAt,
      voidedByName: voidedBy.name,
      voidReason: purchaseAttachments.voidReason,
    })
    .from(purchaseAttachments)
    .innerJoin(privateFiles, eq(privateFiles.id, purchaseAttachments.fileId))
    .leftJoin(createdBy, eq(createdBy.id, purchaseAttachments.createdByStaffUserId))
    .leftJoin(voidedBy, eq(voidedBy.id, purchaseAttachments.voidedByStaffUserId))
    .where(eq(purchaseAttachments.purchaseId, purchaseId))
    .orderBy(asc(purchaseAttachments.createdAt), asc(purchaseAttachments.id));
  return rows.map(({ fileId, fileContentType, fileName, ...row }) => ({
    ...row,
    file: { id: fileId, contentType: fileContentType, originalFilename: fileName },
  }));
}
