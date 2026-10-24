"use server";

import { z } from "zod";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { NO_SUPPLIER_PAYEE_KEY, precheckBatchPayment, recordBatchPayment } from "@/lib/supplier-payments/batch-payments";
import { fieldErrorsOf, firstIssue, paymentFields, paymentFieldsSchema, text, uploadedFile } from "@/lib/supplier-payments/form-input";
import { PAYMENT_MESSAGES } from "@/lib/supplier-payments/payment-records";
import { PROOF_MESSAGES, processPrivateUpload } from "@/lib/supplier-payments/proof-processing";
import type { PaymentStatus } from "@/lib/supplier-payments/status";
import { storePrivateUpload } from "@/lib/supplier-payments/store-upload";

// Supplier payments on a production batch (docs/plans/purchase-payments.md §7, §8, session S4).
// Same keys as purchases, re-checked here: supplier_payments.manage + finance.view_profit.
// Voiding and the duplicate-proof lookup are target-independent
// (components/supplier-payments/actions.ts).

const PAYMENT_KEYS = ["supplier_payments.manage", "finance.view_profit"] as const;
const PAYEE_MISSING = "Pilih penerima pembayaran.";

const recordSchema = paymentFieldsSchema.extend({
  productionBatchId: z.string().uuid(PAYMENT_MESSAGES.batchNotFound),
  // A supplier id, or NO_SUPPLIER_PAYEE_KEY for the lines nobody attributed (P12).
  payee: z
    .string({ message: PAYEE_MISSING })
    .refine((value) => value === NO_SUPPLIER_PAYEE_KEY || z.string().uuid().safeParse(value).success, { message: PAYEE_MISSING }),
});

/** "Catat pembayaran" on a posted batch (§8): validate, read-only pre-check, process + store the
 * proof, then ONE transaction (batch row lock first) for the file row, the payment row and the
 * audit entry. `status` is the chosen payee's, so the toast can say that payee is settled. */
export async function recordBatchPaymentAction(formData: FormData): Promise<ActionResult<{ paymentNo: string; status: PaymentStatus }>> {
  const session = await requireAllPermissions(PAYMENT_KEYS);
  const parsed = recordSchema.safeParse({
    productionBatchId: text(formData, "productionBatchId"),
    payee: text(formData, "payee"),
    ...paymentFields(formData),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error), fieldErrors: fieldErrorsOf(parsed.error) };
  const upload = uploadedFile(formData, "proof", PROOF_MESSAGES.missing);
  if ("error" in upload) return { ok: false, error: upload.error, fieldErrors: { proof: upload.error } };

  const { payee, note, ...rest } = parsed.data;
  const input = { ...rest, supplierId: payee === NO_SUPPLIER_PAYEE_KEY ? null : payee, note: note || null };
  return runAction(async () => {
    await precheckBatchPayment(input);
    const processed = await processPrivateUpload(Buffer.from(await upload.file.arrayBuffer()), upload.file.name);
    const stored = await storePrivateUpload(processed, "payment_proof");
    const result = await recordBatchPayment(input, stored, session.staffUser.id);
    revalidateAdmin("/production");
    return { paymentNo: result.payment.paymentNo, status: result.payee.status };
  });
}
