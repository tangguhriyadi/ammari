"use server";

import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin, revalidateOverview } from "@/lib/admin-revalidate";
import { saveSalesGoal } from "@/lib/settings/sales-goal";
import { salesGoalSchema, type SalesGoalFormInput } from "@/lib/settings/sales-goal-schema";

/** "Target penjualan" (docs/plans/dashboard-overview.md §2.2, D2). settings.manage on the server,
 * whatever the page showed. Validated against today's Jakarta date. */
export async function saveSalesGoalAction(input: SalesGoalFormInput): Promise<ActionResult> {
  const session = await requirePermission("settings.manage");
  const parsed = salesGoalSchema(jakartaDate()).safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "");
      if (field && !fieldErrors[field]) fieldErrors[field] = issue.message;
    }
    const error = parsed.error.issues[0]?.message ?? "Input tidak valid.";
    return Object.keys(fieldErrors).length > 0 ? { ok: false, error, fieldErrors } : { ok: false, error };
  }
  return runAction(async () => {
    await saveSalesGoal({ revenueTargetAmount: parsed.data.revenueTarget, startDate: parsed.data.startDate }, session.staffUser.id);
    revalidateAdmin("/settings");
    revalidateOverview();
    return undefined;
  });
}
