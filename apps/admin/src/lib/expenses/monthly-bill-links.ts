import { expenseGroupOfKind, findExpenseCategory, type ExpenseCategoryInfo } from "@/lib/expense-categories/catalog";
import type { MonthlyBillsWindow } from "./figures";
import type { ExpenseCategoryGroup } from "./labels";
import { expenseListHref, expenseMenuPath } from "./search-params";

// The links of the "Biaya bulanan belum dicatat" reminder on the Overview
// (docs/plans/expense-master-data.md §3.8, session S6 follow-up). Any active category may be a
// monthly bill (owner answer D3), so the missing ones can live in Biaya (Gaji, Sewa) AND in Iklan
// (an owner-picked ad category). One link per menu that holds a missing category, Biaya first,
// each opening that menu's list on the reminder's 6th-to-5th window.

export interface MonthlyBillLink {
  group: ExpenseCategoryGroup;
  label: string;
  href: string;
}

const MENU_LABELS: Record<ExpenseCategoryGroup, string> = { operational: "Biaya", marketing: "Iklan" };

/** `missing` null (nothing missing, or before the 6th): the plain Biaya menu. A code the catalog
 * no longer knows counts as Biaya, the menu of every non-marketing category. */
export function monthlyBillLinks(
  missing: (MonthlyBillsWindow & { missing: readonly string[] }) | null,
  categories: readonly Pick<ExpenseCategoryInfo, "code" | "kind">[],
): [MonthlyBillLink, ...MonthlyBillLink[]] {
  if (!missing || missing.missing.length === 0) {
    return [{ group: "operational", label: `Catat di ${MENU_LABELS.operational}`, href: expenseMenuPath("operational") }];
  }
  const groups = new Set<ExpenseCategoryGroup>(
    missing.missing.map((code) => {
      const category = findExpenseCategory(categories, code);
      return category ? expenseGroupOfKind(category.kind) : "operational";
    }),
  );
  const [first, ...rest] = (["operational", "marketing"] as const)
    .filter((group) => groups.has(group))
    .map((group) => ({
      group,
      label: `Catat di ${MENU_LABELS[group]}`,
      href: expenseListHref({ month: missing.to.slice(0, 7), range: { from: missing.from, to: missing.to }, group, showVoided: false }),
    }));
  // `missing` is non-empty, so at least one group holds a category.
  if (!first) throw new Error("monthly bill reminder without a menu");
  return [first, ...rest];
}
