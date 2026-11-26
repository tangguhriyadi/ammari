"use server";

import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { createTaxSetting, updateTaxSetting } from "@/lib/accounting/tax-settings";
import { TAX_SETTING_MESSAGES } from "@/lib/accounting/tax-settings-input";

// Pengaturan pajak (D-20). Tax settings are accounting.manage (plan §7) on an accounting.view page.

const KEYS = ["accounting.view", "accounting.manage"] as const;
const INVALID_INPUT = "Input tidak valid.";
const text = (max: number) => z.string({ error: INVALID_INPUT }).max(max, INVALID_INPUT);

const formSchema = z.object(
  {
    effectiveFrom: text(20).optional(),
    taxpayerType: text(20),
    taxpayerLabel: text(500),
    npwpRegisteredYear: text(20).nullable().optional(),
    ratePercent: text(20),
    annualExemptionAmount: text(40),
    rateValidUntil: text(20).nullable().optional(),
    note: text(2000).nullable().optional(),
  },
  { error: INVALID_INPUT },
);

function validationError(error: z.ZodError): ActionResult<never> {
  const issue = error.issues[0];
  const message = issue?.message ?? INVALID_INPUT;
  const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
  return { ok: false, error: message, fieldErrors: field ? { [field]: message } : undefined };
}

export async function createTaxSettingAction(input: z.input<typeof formSchema>): Promise<ActionResult<{ effectiveFrom: string }>> {
  const session = await requireAllPermissions(KEYS);
  const parsed = formSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const created = await createTaxSetting(parsed.data, session.staffUser.id);
    revalidateAdmin("/accounting");
    return { effectiveFrom: created.effectiveFrom };
  });
}

export async function updateTaxSettingAction(effectiveFrom: string, input: z.input<typeof formSchema>): Promise<ActionResult> {
  const session = await requireAllPermissions(KEYS);
  if (typeof effectiveFrom !== "string" || !/^\d{4}-\d{2}-01$/.test(effectiveFrom)) return { ok: false, error: TAX_SETTING_MESSAGES.notFound };
  const parsed = formSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    await updateTaxSetting(effectiveFrom, parsed.data, session.staffUser.id);
    revalidateAdmin("/accounting");
    return undefined;
  });
}
