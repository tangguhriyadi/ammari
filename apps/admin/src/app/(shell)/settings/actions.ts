"use server";

import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin, revalidateOverview } from "@/lib/admin-revalidate";
import { MONTHLY_BILLS_MESSAGES, parseMonthlyBillCategories, saveMonthlyBillCategories } from "@/lib/settings/monthly-bills";
import { saveSalesGoal } from "@/lib/settings/sales-goal";
import { SALES_GOAL_PERMISSIONS } from "@/lib/settings/sales-goal-permissions";
import { salesGoalSchema, type SalesGoalFormInput } from "@/lib/settings/sales-goal-schema";

/** "Target penjualan" (docs/plans/dashboard-overview.md §2.2, D2). settings.manage AND
 * finance.view_profit on the server, whatever the page showed: the target is a revenue figure
 * (D9). Validated against today's Jakarta date. */
export async function saveSalesGoalAction(input: SalesGoalFormInput): Promise<ActionResult> {
  const session = await requireAllPermissions(SALES_GOAL_PERMISSIONS);
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

/** "Pengingat biaya bulanan" (docs/plans/growth.md §6, owner answer A6): the same gate as Target
 * penjualan (settings.manage AND finance.view_profit, on the server). Only offered categories are
 * accepted; an empty list turns the reminder off. */
export async function saveMonthlyBillsReminderAction(input: { categories: unknown }): Promise<ActionResult> {
  const session = await requireAllPermissions(SALES_GOAL_PERMISSIONS);
  const categories = parseMonthlyBillCategories(input?.categories);
  if (!categories) return { ok: false, error: MONTHLY_BILLS_MESSAGES.invalid, fieldErrors: { categories: MONTHLY_BILLS_MESSAGES.invalid } };
  return runAction(async () => {
    await saveMonthlyBillCategories(categories, session.staffUser.id);
    revalidateAdmin("/settings");
    revalidateOverview();
    return undefined;
  });
}
