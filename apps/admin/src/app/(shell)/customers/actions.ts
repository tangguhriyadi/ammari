"use server";

import { z } from "zod";
import { extendVoucher, voidVoucher } from "@ammari/commerce/voucher-adjustments";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin, revalidateOverview } from "@/lib/admin-revalidate";
import { PROMO_WITHDRAWAL_MESSAGES, withdrawPromoConsent } from "@/lib/customers/consent";
import { PROMO_WITHDRAWAL_SOURCES } from "@/lib/customers/consent-options";
import { firstIssue } from "@/lib/supplier-payments/form-input";

// "Pelanggan & Voucher" actions (docs/plans/growth.md §8.3, §9.3). Each re-checks its keys on the
// server: customers.view (every action starts from the customer pages) plus customers.manage for
// a promo withdrawal (A7) or vouchers.void for a void or an extension (A8; owner and super_admin,
// never CS). None of them returns customer data.

const NOT_FOUND = "Data tidak ditemukan.";

const withdrawSchema = z.object({
  customerId: z.string().uuid(NOT_FOUND),
  source: z.enum(PROMO_WITHDRAWAL_SOURCES, { message: PROMO_WITHDRAWAL_MESSAGES.source }),
  note: z.string().optional(),
});

export async function withdrawPromoConsentAction(input: z.input<typeof withdrawSchema>): Promise<ActionResult> {
  const session = await requireAllPermissions(["customers.view", "customers.manage"]);
  const parsed = withdrawSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  return runAction(async () => {
    await withdrawPromoConsent(parsed.data, session.staffUser.id);
    revalidateAdmin("/customers");
    return undefined;
  });
}

const voidSchema = z.object({
  id: z.string().uuid(NOT_FOUND),
  reason: z.string(),
});

export async function voidVoucherAction(input: z.input<typeof voidSchema>): Promise<ActionResult> {
  const session = await requireAllPermissions(["customers.view", "vouchers.void"]);
  const parsed = voidSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  return runAction(async () => {
    await voidVoucher({ voucherId: parsed.data.id, reason: parsed.data.reason, actorStaffUserId: session.staffUser.id });
    revalidateAdmin("/customers");
    revalidateOverview();
    return undefined;
  });
}

const extendSchema = z.object({
  id: z.string().uuid(NOT_FOUND),
  newExpiryDate: z.string(),
  reason: z.string(),
});

export async function extendVoucherAction(input: z.input<typeof extendSchema>): Promise<ActionResult> {
  const session = await requireAllPermissions(["customers.view", "vouchers.void"]);
  const parsed = extendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  return runAction(async () => {
    await extendVoucher({ voucherId: parsed.data.id, newExpiryDate: parsed.data.newExpiryDate, reason: parsed.data.reason, actorStaffUserId: session.staffUser.id });
    revalidateAdmin("/customers");
    revalidateOverview();
    return undefined;
  });
}
