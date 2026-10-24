import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  privateFiles,
  purchaseAttachments,
  purchaseItems,
  purchases,
  staffUsers,
  supplierPayments,
  suppliers,
  type PrivateFileContentType,
  type PurchaseStatus,
  type SupplierPaymentMethod,
} from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { nextDocumentNumber } from "@/lib/documents/document-number";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { getLineQuantities, lockPurchaseForUpdate } from "@/lib/purchases/queries";
import { getPurchasePaymentAmounts } from "./purchase-paid";
import { paymentAmountError, purchasePaymentSummary, summarizePayment, type PaymentSummary } from "./status";
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

export const MAX_NOTE_LENGTH = 500;
export const MAX_REASON_LENGTH = 500;

export const PAYMENT_METHOD_LABELS: Record<SupplierPaymentMethod, string> = {
  cash: "Tunai",
  transfer: "Transfer",
};

export const PAYMENT_MESSAGES = {
  purchaseNotFound: "Pesanan pembelian tidak ditemukan.",
  cancelled: "Pesanan yang dibatalkan tidak bisa dibayar.",
  futureDate: "Tanggal bayar tidak boleh di masa depan.",
  invalidDate: "Tanggal bayar tidak valid.",
  noteTooLong: `Catatan maksimal ${MAX_NOTE_LENGTH} karakter.`,
  reasonRequired: "Alasan pembatalan wajib diisi.",
  reasonTooLong: `Alasan maksimal ${MAX_REASON_LENGTH} karakter.`,
  paymentNotFound: "Pembayaran tidak ditemukan.",
  alreadyVoided: "Pembayaran ini sudah dibatalkan.",
  attachmentNotFound: "Nota tidak ditemukan.",
  attachmentAlreadyVoided: "Nota ini sudah dibatalkan.",
} as const;

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

function assertPaidAt(paidAt: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt) || Number.isNaN(Date.parse(`${paidAt}T00:00:00Z`))) {
    throw new FieldError("paidAt", PAYMENT_MESSAGES.invalidDate);
  }
  // A9: only "not in the future" (Asia/Jakarta), no lower bound.
  if (paidAt > todayInJakarta()) throw new FieldError("paidAt", PAYMENT_MESSAGES.futureDate);
}

function normalizeNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? "";
  if (trimmed.length > MAX_NOTE_LENGTH) throw new FieldError("note", PAYMENT_MESSAGES.noteTooLong);
  return trimmed === "" ? null : trimmed;
}

function normalizeReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === "") throw new FieldError("reason", PAYMENT_MESSAGES.reasonRequired);
  if (trimmed.length > MAX_REASON_LENGTH) throw new FieldError("reason", PAYMENT_MESSAGES.reasonTooLong);
  return trimmed;
}

function assertAmountAllowed(amount: number, summary: PaymentSummary): void {
  const error = paymentAmountError(amount, summary);
  if (error) throw new FieldError("amount", error);
}

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

function privateFileValues(file: StoredPrivateFile, actorStaffUserId: string) {
  return {
    id: file.id,
    purpose: file.purpose,
    storageKey: file.storageKey,
    contentType: file.processed.contentType,
    byteSize: file.processed.byteSize,
    sha256: file.processed.sha256,
    originalFilename: file.processed.originalFilename,
    originalContentType: file.processed.originalContentType,
    originalByteSize: file.processed.originalByteSize,
    originalSha256: file.processed.originalSha256,
    uploadedByStaffUserId: actorStaffUserId,
  };
}

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
  if (file.purpose !== "payment_proof") throw new Error(`expected a payment_proof file, got ${file.purpose}`);

  return db.transaction(async (tx) => {
    const purchase = await lockPurchaseForUpdate(tx, input.purchaseId);
    if (!purchase) throw new ActionError(PAYMENT_MESSAGES.purchaseNotFound);
    if (purchase.status === "cancelled") throw new ActionError(PAYMENT_MESSAGES.cancelled);
    const before = await computePurchasePaymentSummary(purchase, tx);
    assertAmountAllowed(input.amount, before);

    const paymentNo = await nextDocumentNumber(tx, "BYR", supplierPayments.paymentNo);
    const [supplier] = await tx.select({ name: suppliers.name }).from(suppliers).where(eq(suppliers.id, purchase.supplierId));
    if (!supplier) throw new Error(`supplier ${purchase.supplierId} of purchase ${purchase.id} not found`);

    const [fileRow] = await tx.insert(privateFiles).values(privateFileValues(file, actorStaffUserId)).returning();
    if (!fileRow) throw new Error("failed to insert private file");
    const [payment] = await tx
      .insert(supplierPayments)
      .values({
        paymentNo,
        targetType: "purchase",
        purchaseId: purchase.id,
        supplierId: purchase.supplierId,
        supplierName: supplier.name,
        paidAt: input.paidAt,
        amount: input.amount,
        method: input.method,
        note,
        proofFileId: fileRow.id,
        recordedByStaffUserId: actorStaffUserId,
      })
      .returning();
    if (!payment) throw new Error("failed to insert supplier payment");

    // Viewing a proof is never audited (A10); recording and voiding are.
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "record",
      entityType: "supplier_payment",
      entityId: payment.id,
      after: { payment, file: fileRow },
    });
    return { payment, summary: summarizePayment(before.tagihan, before.paid + input.amount) };
  });
}

/** §8 voidSupplierPayment: void-once by a conditional UPDATE under the purchase row lock. Zero
 * rows back means someone else voided it first. */
export async function voidPurchasePayment(paymentId: string, reason: string, actorStaffUserId: string, db: Database = defaultDb) {
  const trimmed = normalizeReason(reason);

  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(supplierPayments).where(eq(supplierPayments.id, paymentId));
    if (!target || target.purchaseId === null) throw new ActionError(PAYMENT_MESSAGES.paymentNotFound);
    // The FK guarantees the purchase exists; the lock only orders this write (plan §4.6).
    if (!(await lockPurchaseForUpdate(tx, target.purchaseId))) throw new Error(`purchase ${target.purchaseId} not found`);

    const [payment] = await tx
      .update(supplierPayments)
      .set({ voidedAt: new Date(), voidedByStaffUserId: actorStaffUserId, voidReason: trimmed })
      .where(and(eq(supplierPayments.id, paymentId), isNull(supplierPayments.voidedAt)))
      .returning();
    if (!payment) throw new ActionError(PAYMENT_MESSAGES.alreadyVoided);

    await writeAuditLog(tx, { actorStaffUserId, action: "void", entityType: "supplier_payment", entityId: paymentId, before: target, after: payment });
    return payment;
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

export interface PrivateFileRef {
  id: string;
  contentType: PrivateFileContentType;
  originalFilename: string;
}

export interface PurchasePaymentRow {
  id: string;
  paymentNo: string;
  paidAt: string;
  method: SupplierPaymentMethod;
  amount: number;
  supplierName: string | null;
  note: string | null;
  recordedByName: string | null;
  createdAt: Date;
  proof: PrivateFileRef;
  voidedAt: Date | null;
  voidedByName: string | null;
  voidReason: string | null;
}

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

/** Payment history in the order the money moved (paid date, then recording time). Voided rows
 * stay in it (P6). Amount data: the caller renders it only for finance.view_profit (§7). */
export async function listPurchasePayments(purchaseId: string, db: Database = defaultDb): Promise<PurchasePaymentRow[]> {
  const recordedBy = alias(staffUsers, "recorded_by");
  const voidedBy = alias(staffUsers, "voided_by");
  const rows = await db
    .select({
      id: supplierPayments.id,
      paymentNo: supplierPayments.paymentNo,
      paidAt: supplierPayments.paidAt,
      method: supplierPayments.method,
      amount: supplierPayments.amount,
      supplierName: supplierPayments.supplierName,
      note: supplierPayments.note,
      recordedByName: recordedBy.name,
      createdAt: supplierPayments.createdAt,
      fileId: privateFiles.id,
      fileContentType: privateFiles.contentType,
      fileName: privateFiles.originalFilename,
      voidedAt: supplierPayments.voidedAt,
      voidedByName: voidedBy.name,
      voidReason: supplierPayments.voidReason,
    })
    .from(supplierPayments)
    .innerJoin(privateFiles, eq(privateFiles.id, supplierPayments.proofFileId))
    .leftJoin(recordedBy, eq(recordedBy.id, supplierPayments.recordedByStaffUserId))
    .leftJoin(voidedBy, eq(voidedBy.id, supplierPayments.voidedByStaffUserId))
    .where(eq(supplierPayments.purchaseId, purchaseId))
    .orderBy(asc(supplierPayments.paidAt), asc(supplierPayments.createdAt), asc(supplierPayments.paymentNo));
  return rows.map(({ fileId, fileContentType, fileName, ...row }) => ({
    ...row,
    proof: { id: fileId, contentType: fileContentType, originalFilename: fileName },
  }));
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

/** §8 step 4, the soft duplicate-proof warning: the payment numbers whose (non-voided) proof was
 * uploaded with exactly these bytes. Read-only and advisory; never blocks a payment. */
export async function findPaymentsWithProofHash(originalSha256: string, db: Database = defaultDb): Promise<string[]> {
  if (!/^[0-9a-f]{64}$/.test(originalSha256)) return [];
  const rows = await db
    .select({ paymentNo: supplierPayments.paymentNo })
    .from(supplierPayments)
    .innerJoin(privateFiles, eq(privateFiles.id, supplierPayments.proofFileId))
    .where(and(eq(privateFiles.originalSha256, originalSha256), isNull(supplierPayments.voidedAt)))
    .orderBy(asc(supplierPayments.paymentNo))
    .limit(5);
  return rows.map((row) => row.paymentNo);
}
