"use server";

import { z } from "zod";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { runAction, type ActionResult } from "@/lib/action-result";
import { ActionError } from "@/lib/errors";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { fieldErrorsOf, firstIssue, noteSchema, paymentFields, paymentFieldsSchema, text, uploadedFile } from "@/lib/supplier-payments/form-input";
import { MAX_REASON_LENGTH, PAYMENT_MESSAGES } from "@/lib/supplier-payments/payment-records";
import {
  attachPurchaseInvoice,
  precheckPurchasePayment,
  purchaseExists,
  recordPurchasePayment,
  voidPurchaseAttachment,
} from "@/lib/supplier-payments/purchase-payments";
import { PROOF_MESSAGES, processPrivateUpload } from "@/lib/supplier-payments/proof-processing";
import type { PaymentStatus } from "@/lib/supplier-payments/status";
import { storePrivateUpload } from "@/lib/supplier-payments/store-upload";

// Supplier payments and notas on a purchase document (docs/plans/purchase-payments.md §7, §8,
// session S3). Every action re-checks its permissions on the server (§7):
// - record a payment: supplier_payments.manage + finance.view_profit (voiding and the
//   duplicate-proof lookup are target-independent: components/supplier-payments/actions.ts)
// - attach/void a nota: inventory.manage + finance.view_profit (same as editing a purchase)

const PAYMENT_KEYS = ["supplier_payments.manage", "finance.view_profit"] as const;
const INVOICE_KEYS = ["inventory.manage", "finance.view_profit"] as const;
// /suppliers shows no payment data until S5 (supplier utang).
const PAYMENT_SECTIONS = ["/purchases"] as const;
const NOTA_MISSING = "File nota wajib dipilih.";

const recordSchema = paymentFieldsSchema.extend({
  purchaseId: z.string().uuid(PAYMENT_MESSAGES.purchaseNotFound),
});

/** "Catat pembayaran" (§8): validate, read-only pre-check, process + store the proof, then ONE
 * transaction for the file row, the payment row and the audit entry. */
export async function recordPurchasePaymentAction(formData: FormData): Promise<ActionResult<{ paymentNo: string; status: PaymentStatus }>> {
  const session = await requireAllPermissions(PAYMENT_KEYS);
  const parsed = recordSchema.safeParse({ purchaseId: text(formData, "purchaseId"), ...paymentFields(formData) });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error), fieldErrors: fieldErrorsOf(parsed.error) };
  const upload = uploadedFile(formData, "proof", PROOF_MESSAGES.missing);
  if ("error" in upload) return { ok: false, error: upload.error, fieldErrors: { proof: upload.error } };

  const input = { ...parsed.data, note: parsed.data.note || null };
  return runAction(async () => {
    await precheckPurchasePayment(input);
    const processed = await processPrivateUpload(Buffer.from(await upload.file.arrayBuffer()), upload.file.name);
    const stored = await storePrivateUpload(processed, "payment_proof");
    const { payment, summary } = await recordPurchasePayment(input, stored, session.staffUser.id);
    revalidateAdmin(...PAYMENT_SECTIONS);
    return { paymentNo: payment.paymentNo, status: summary.status };
  });
}

const voidAttachmentSchema = z.object({
  id: z.string().uuid(PAYMENT_MESSAGES.attachmentNotFound),
  reason: z.string().trim().min(1, PAYMENT_MESSAGES.reasonRequired).max(MAX_REASON_LENGTH, PAYMENT_MESSAGES.reasonTooLong),
});

const attachSchema = z.object({
  purchaseId: z.string().uuid(PAYMENT_MESSAGES.purchaseNotFound),
  note: noteSchema,
});

export async function attachPurchaseInvoiceAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAllPermissions(INVOICE_KEYS);
  const parsed = attachSchema.safeParse({ purchaseId: text(formData, "purchaseId"), note: text(formData, "note") });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error), fieldErrors: fieldErrorsOf(parsed.error) };
  const upload = uploadedFile(formData, "file", NOTA_MISSING);
  if ("error" in upload) return { ok: false, error: upload.error, fieldErrors: { file: upload.error } };

  return runAction(async () => {
    // Read-only, before storing anything, so a stale id leaves no unreferenced object behind.
    if (!(await purchaseExists(parsed.data.purchaseId))) throw new ActionError(PAYMENT_MESSAGES.purchaseNotFound);
    const processed = await processPrivateUpload(Buffer.from(await upload.file.arrayBuffer()), upload.file.name, { missingMessage: NOTA_MISSING });
    const stored = await storePrivateUpload(processed, "purchase_invoice");
    await attachPurchaseInvoice({ purchaseId: parsed.data.purchaseId, note: parsed.data.note || null }, stored, session.staffUser.id);
    revalidateAdmin("/purchases");
    return undefined;
  });
}

export async function voidPurchaseAttachmentAction(input: z.input<typeof voidAttachmentSchema>): Promise<ActionResult> {
  const session = await requireAllPermissions(INVOICE_KEYS);
  const parsed = voidAttachmentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  return runAction(async () => {
    await voidPurchaseAttachment(parsed.data.id, parsed.data.reason, session.staffUser.id);
    revalidateAdmin("/purchases");
    return undefined;
  });
}
