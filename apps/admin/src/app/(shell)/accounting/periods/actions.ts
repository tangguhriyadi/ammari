"use server";

import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { MAX_PERIOD_REASON_LENGTH, PERIOD_MESSAGES } from "@/lib/accounting/period-rules";
import { closePeriod, reopenPeriod } from "@/lib/accounting/periods";

// Tutup buku (docs/plans/accounting.md §7, D-23, Session 4): accounting.view + accounting.close
// (the owner or the accountant), checked here on the server for every call.

const KEYS = ["accounting.view", "accounting.close"] as const;
const month = z.string().regex(/^\d{4}-\d{2}-01$/, PERIOD_MESSAGES.invalidMonth);

const closeSchema = z.object({ month, overrideReason: z.string().max(MAX_PERIOD_REASON_LENGTH + 100, PERIOD_MESSAGES.overrideTooLong).optional() });

export async function closePeriodAction(input: z.input<typeof closeSchema>): Promise<ActionResult> {
  const session = await requireAllPermissions(KEYS);
  const parsed = closeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? PERIOD_MESSAGES.invalidMonth };
  return runAction(async () => {
    await closePeriod(parsed.data.month, parsed.data.overrideReason ?? null, session.staffUser.id);
    revalidateAdmin("/accounting");
    return undefined;
  });
}

const reopenSchema = z.object({ month, reason: z.string().max(MAX_PERIOD_REASON_LENGTH + 100, PERIOD_MESSAGES.reopenReasonTooLong) });

export async function reopenPeriodAction(input: z.input<typeof reopenSchema>): Promise<ActionResult> {
  const session = await requireAllPermissions(KEYS);
  const parsed = reopenSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? PERIOD_MESSAGES.invalidMonth };
  return runAction(async () => {
    await reopenPeriod(parsed.data.month, parsed.data.reason, session.staffUser.id);
    revalidateAdmin("/accounting");
    return undefined;
  });
}
