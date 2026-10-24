"use server";

import { z } from "zod";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { findPaymentsWithProofHash, MAX_REASON_LENGTH, PAYMENT_MESSAGES, voidSupplierPayment } from "@/lib/supplier-payments/payment-records";

// The supplier-payment actions that do not depend on what the payment settles
// (docs/plans/purchase-payments.md §7, §8): voiding, and the duplicate-proof lookup. Both need
// supplier_payments.manage + finance.view_profit, re-checked here on every call. Recording lives
// with its target (purchases/payment-actions.ts, production/payment-actions.ts).

const PAYMENT_KEYS = ["supplier_payments.manage", "finance.view_profit"] as const;
// Every page that shows payment state. /suppliers shows no payment data until S5 (supplier utang).
const PAYMENT_SECTIONS = ["/purchases", "/production"] as const;

const voidSchema = z.object({
  id: z.string().uuid(PAYMENT_MESSAGES.paymentNotFound),
  reason: z.string().trim().min(1, PAYMENT_MESSAGES.reasonRequired).max(MAX_REASON_LENGTH, PAYMENT_MESSAGES.reasonTooLong),
});

/** "Batalkan pembayaran" (P6): void once, with a required reason, whatever the payment settles. */
export async function voidSupplierPaymentAction(input: z.input<typeof voidSchema>): Promise<ActionResult> {
  const session = await requireAllPermissions(PAYMENT_KEYS);
  const parsed = voidSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await voidSupplierPayment(parsed.data.id, parsed.data.reason, session.staffUser.id);
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
