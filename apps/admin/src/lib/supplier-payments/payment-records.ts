import "server-only";
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  privateFiles,
  staffUsers,
  supplierPayments,
  type PrivateFileContentType,
  type SupplierPaymentMethod,
} from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { nextDocumentNumber } from "@/lib/documents/document-number";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { lockProductionBatchForUpdate } from "@/lib/production/db";
import { lockPurchaseForUpdate } from "@/lib/purchases/queries";
import { paymentAmountError, type PaymentSummary } from "./status";
import type { StoredPrivateFile } from "./store-upload";

// What every supplier payment shares, whatever it settles (docs/plans/purchase-payments.md §8):
// input rules, the insert of file row + payment row + audit entry, the void, and the history
// read. The target-specific parts (which row to lock, what is due) live in purchase-payments.ts
// (S3) and batch-payments.ts (S4).
//
// Lock order inside every write (plan §4.6, §5.7): the parent row (purchase or batch) FIRST,
// then nextDocumentNumber's advisory lock, then the inserts. The private_files row is inserted
// only after the cap check, in the payment's own transaction: rows are undeletable, so an orphan
// row could never be cleaned up.

export const MAX_NOTE_LENGTH = 500;
export const MAX_REASON_LENGTH = 500;

export { PAYMENT_METHOD_LABELS } from "./messages";

export const PAYMENT_MESSAGES = {
  purchaseNotFound: "Pesanan pembelian tidak ditemukan.",
  cancelled: "Pesanan yang dibatalkan tidak bisa dibayar.",
  batchNotFound: "Batch produksi tidak ditemukan.",
  batchNotPosted: "Batch yang belum diposting belum punya tagihan. Posting batch dulu, lalu catat pembayarannya.",
  payeeUnknown: "Penerima ini tidak ada di biaya batch ini.",
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

// ---------- Validation ----------

export function assertPaidAt(paidAt: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt) || Number.isNaN(Date.parse(`${paidAt}T00:00:00Z`))) {
    throw new FieldError("paidAt", PAYMENT_MESSAGES.invalidDate);
  }
  // A9: only "not in the future" (Asia/Jakarta), no lower bound.
  if (paidAt > todayInJakarta()) throw new FieldError("paidAt", PAYMENT_MESSAGES.futureDate);
}

export function normalizeNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? "";
  if (trimmed.length > MAX_NOTE_LENGTH) throw new FieldError("note", PAYMENT_MESSAGES.noteTooLong);
  return trimmed === "" ? null : trimmed;
}

export function normalizeReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === "") throw new FieldError("reason", PAYMENT_MESSAGES.reasonRequired);
  if (trimmed.length > MAX_REASON_LENGTH) throw new FieldError("reason", PAYMENT_MESSAGES.reasonTooLong);
  return trimmed;
}

export function assertAmountAllowed(amount: number, summary: PaymentSummary): void {
  const error = paymentAmountError(amount, summary);
  if (error) throw new FieldError("amount", error);
}

// ---------- Writes ----------

export function privateFileValues(file: StoredPrivateFile, actorStaffUserId: string) {
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

export interface SupplierPaymentInsert {
  target: { type: "purchase"; purchaseId: string } | { type: "production_batch"; productionBatchId: string };
  supplierId: string | null;
  supplierName: string | null;
  paidAt: string;
  amount: number;
  method: SupplierPaymentMethod;
  note: string | null;
}

/** The inserts of §8 step 3, AFTER the caller locked the parent row and checked the cap: payment
 * number (advisory lock), private_files row, supplier_payments row, audit entry `record`. Viewing
 * a proof is never audited (A10). */
export async function insertSupplierPayment(tx: Tx, values: SupplierPaymentInsert, file: StoredPrivateFile, actorStaffUserId: string) {
  if (file.purpose !== "payment_proof") throw new Error(`expected a payment_proof file, got ${file.purpose}`);
  const paymentNo = await nextDocumentNumber(tx, "BYR", supplierPayments.paymentNo);
  const [fileRow] = await tx.insert(privateFiles).values(privateFileValues(file, actorStaffUserId)).returning();
  if (!fileRow) throw new Error("failed to insert private file");
  const [payment] = await tx
    .insert(supplierPayments)
    .values({
      paymentNo,
      targetType: values.target.type,
      purchaseId: values.target.type === "purchase" ? values.target.purchaseId : null,
      productionBatchId: values.target.type === "production_batch" ? values.target.productionBatchId : null,
      supplierId: values.supplierId,
      supplierName: values.supplierName,
      paidAt: values.paidAt,
      amount: values.amount,
      method: values.method,
      note: values.note,
      proofFileId: fileRow.id,
      recordedByStaffUserId: actorStaffUserId,
    })
    .returning();
  if (!payment) throw new Error("failed to insert supplier payment");

  await writeAuditLog(tx, {
    actorStaffUserId,
    action: "record",
    entityType: "supplier_payment",
    entityId: payment.id,
    after: { payment, file: fileRow },
  });
  return payment;
}

/** §8 voidSupplierPayment, for a payment on any target: void-once by a conditional UPDATE under
 * the parent row's lock (the purchase or the batch, the same lock recording takes). Zero rows
 * back means someone else voided it first. */
export async function voidSupplierPayment(paymentId: string, reason: string, actorStaffUserId: string, db: Database = defaultDb) {
  const trimmed = normalizeReason(reason);

  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(supplierPayments).where(eq(supplierPayments.id, paymentId));
    if (!target) throw new ActionError(PAYMENT_MESSAGES.paymentNotFound);
    // The FKs guarantee the parent exists; the lock only orders this write (plan §4.6).
    if (target.purchaseId !== null) {
      if (!(await lockPurchaseForUpdate(tx, target.purchaseId))) throw new Error(`purchase ${target.purchaseId} not found`);
    } else if (target.productionBatchId !== null) {
      if (!(await lockProductionBatchForUpdate(tx, target.productionBatchId))) throw new Error(`production batch ${target.productionBatchId} not found`);
    } else {
      throw new Error(`supplier payment ${paymentId} has no target`);
    }

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

// ---------- Reads ----------

export interface PrivateFileRef {
  id: string;
  contentType: PrivateFileContentType;
  originalFilename: string;
}

export interface SupplierPaymentRow {
  id: string;
  paymentNo: string;
  paidAt: string;
  method: SupplierPaymentMethod;
  amount: number;
  supplierId: string | null;
  supplierName: string | null;
  note: string | null;
  recordedByName: string | null;
  createdAt: Date;
  proof: PrivateFileRef;
  voidedAt: Date | null;
  voidedByName: string | null;
  voidReason: string | null;
}

/** Payment history in the order the money moved (paid date, then recording time). Voided rows
 * stay in it (P6). Amount data: the caller renders it only for finance.view_profit (§7). */
export async function listSupplierPayments(target: SQL, db: Database = defaultDb): Promise<SupplierPaymentRow[]> {
  const recordedBy = alias(staffUsers, "recorded_by");
  const voidedBy = alias(staffUsers, "voided_by");
  const rows = await db
    .select({
      id: supplierPayments.id,
      paymentNo: supplierPayments.paymentNo,
      paidAt: supplierPayments.paidAt,
      method: supplierPayments.method,
      amount: supplierPayments.amount,
      supplierId: supplierPayments.supplierId,
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
    .where(target)
    .orderBy(asc(supplierPayments.paidAt), asc(supplierPayments.createdAt), asc(supplierPayments.paymentNo));
  return rows.map(({ fileId, fileContentType, fileName, ...row }) => ({
    ...row,
    proof: { id: fileId, contentType: fileContentType, originalFilename: fileName },
  }));
}

/** §8 step 4, the soft duplicate-proof warning: the payment numbers whose (non-voided) proof was
 * uploaded with exactly these bytes, on any target. Read-only and advisory; never blocks a
 * payment. */
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
