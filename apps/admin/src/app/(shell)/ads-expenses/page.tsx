import { permanentRedirect } from "next/navigation";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { loadExpenseCategoryCatalog } from "@/lib/expense-categories/queries";
import { legacyAdsExpensesHref, legacyExpenseNoQuery } from "@/lib/expenses/legacy-redirect";
import { findExpenseByNo } from "@/lib/expenses/records";

// The old "Iklan & Biaya" page, now redirect-only (docs/plans/expense-master-data.md §3.8, session
// S5): bookmarks, the old Overview links and older activity-log entries land on "Iklan" (/ads) or
// "Biaya" (/expenses). The target depends on query values (a category's or an expense's kind),
// which next.config.ts redirects() cannot map, hence a page. The permission check runs first, the
// same pair as the targets, so the lookup never runs for a viewer who could not see the answer.

export default async function AdsExpensesRedirectPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAllPermissions(["ads_expenses.manage", "finance.view_profit"]);
  const raw = await searchParams;
  const expenseNo = legacyExpenseNoQuery(raw);
  const [{ categories }, expense] = await Promise.all([loadExpenseCategoryCatalog(), expenseNo ? findExpenseByNo(expenseNo) : null]);
  permanentRedirect(legacyAdsExpensesHref(raw, { categories, expense }));
}
