"use server";

import { z } from "zod";
import { SUPPLIER_PAYMENT_METHODS } from "@ammari/db/schema";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { runAction, type ActionResult } from "@/lib/action-result";
import { ActionError } from "@/lib/errors";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { parseRupiah } from "@/lib/products/money";
import {
  attachPurchaseInvoice,
  findPaymentsWithProofHash,
  MAX_NOTE_LENGTH,
  MAX_REASON_LENGTH,
  PAYMENT_MESSAGES,
  precheckPurchasePayment,
  purchaseExists,
  recordPurchasePayment,
  voidPurchaseAttachment,
  voidPurchasePayment,
} from "@/lib/supplier-payments/purchase-payments";
import { PRIVATE_UPLOAD_MAX_INPUT_BYTES, PROOF_MESSAGES, processPrivateUpload } from "@/lib/supplier-payments/proof-processing";
import type { PaymentStatus } from "@/lib/supplier-payments/status";
import { storePrivateUpload } from "@/lib/supplier-payments/store-upload";

// Supplier payments and notas on a purchase document (docs/plans/purchase-payments.md §7, §8,
// session S3). Every action re-checks its permissions on the server (§7):
// - record/void a payment, and the duplicate-proof lookup: supplier_payments.manage + finance.view_profit
// - attach/void a nota: inventory.manage + finance.view_profit (same as editing a purchase)

const PAYMENT_KEYS = ["supplier_payments.manage", "finance.view_profit"] as const;
const INVOICE_KEYS = ["inventory.manage", "finance.view_profit"] as const;
// /suppliers shows no payment data until S5 (supplier utang).
const PAYMENT_SECTIONS = ["/purchases"] as const;
const NOTA_MISSING = "File nota wajib dipilih.";

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Input tidak valid.";
}

function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    fieldErrors[field] ??= issue.message;
  }
  return fieldErrors;
}

function text(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

const noteSchema = z.string().trim().max(MAX_NOTE_LENGTH, PAYMENT_MESSAGES.noteTooLong).optional();

const recordSchema = z.object({
  purchaseId: z.string().uuid(PAYMENT_MESSAGES.purchaseNotFound),
  paidAt: z.string().date(PAYMENT_MESSAGES.invalidDate),
  amount: z.string().transform((value, ctx) => {
    const parsed = parseRupiah(value);
    if (parsed === null || parsed <= 0 || !Number.isSafeInteger(parsed)) {
      ctx.addIssue({ code: "custom", message: "Jumlah harus bilangan bulat lebih dari 0." });
      return z.NEVER;
    }
    return parsed;
  }),
  method: z.enum(SUPPLIER_PAYMENT_METHODS, { message: "Pilih metode pembayaran." }),
  note: noteSchema,
});

/** The uploaded file, or an Indonesian refusal before any byte is read. */
function uploadedFile(formData: FormData, name: string, missingMessage: string): { file: File } | { error: string } {
  const file = formData.get(name);
  if (!(file instanceof File) || file.size === 0) return { error: missingMessage };
  if (file.size > PRIVATE_UPLOAD_MAX_INPUT_BYTES) return { error: PROOF_MESSAGES.tooLarge };
  return { file };
}

/** "Catat pembayaran" (§8): validate, read-only pre-check, process + store the proof, then ONE
 * transaction for the file row, the payment row and the audit entry. */
export async function recordPurchasePaymentAction(formData: FormData): Promise<ActionResult<{ paymentNo: string; status: PaymentStatus }>> {
  const session = await requireAllPermissions(PAYMENT_KEYS);
  const parsed = recordSchema.safeParse({
    purchaseId: text(formData, "purchaseId"),
    paidAt: text(formData, "paidAt"),
    amount: text(formData, "amount") ?? "",
    method: text(formData, "method"),
    note: text(formData, "note"),
  });
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

const voidSchema = z.object({
  id: z.string().uuid(PAYMENT_MESSAGES.paymentNotFound),
  reason: z.string().trim().min(1, PAYMENT_MESSAGES.reasonRequired).max(MAX_REASON_LENGTH, PAYMENT_MESSAGES.reasonTooLong),
});

export async function voidPurchasePaymentAction(input: z.input<typeof voidSchema>): Promise<ActionResult> {
  const session = await requireAllPermissions(PAYMENT_KEYS);
  const parsed = voidSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  return runAction(async () => {
    await voidPurchasePayment(parsed.data.id, parsed.data.reason, session.staffUser.id);
    revalidateAdmin(...PAYMENT_SECTIONS);
    return undefined;
  });
}

/** §8 step 4: advisory only. The hash is of the exact bytes the browser is about to upload. */
export async function findDuplicateProofAction(input: { sha256: string }): Promise<ActionResult<{ paymentNos: string[] }>> {
  await requireAllPermissions(PAYMENT_KEYS);
  const parsed = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).safeParse(input);
  if (!parsed.success) return { ok: true, data: { paymentNos: [] } };
  return runAction(async () => ({ paymentNos: await findPaymentsWithProofHash(parsed.data.sha256) }));
}

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

const voidAttachmentSchema = voidSchema.extend({ id: z.string().uuid(PAYMENT_MESSAGES.attachmentNotFound) });

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
