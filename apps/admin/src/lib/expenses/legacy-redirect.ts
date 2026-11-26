import type { ExpenseCategoryKind } from "@ammari/db/schema";
import { expenseGroupOfKind, findExpenseCategory, type ExpenseCategoryInfo } from "@/lib/expense-categories/catalog";
import { EXPENSE_CATEGORY_GROUPS, type ExpenseCategoryGroup } from "./labels";
import { EXPENSE_REPORT_PATH, expenseMenuPath, expenseSummaryPath } from "./search-params";

// Where an old "Iklan & Biaya" URL (/ads-expenses?...) lands since the menu split
// (docs/plans/expense-master-data.md §3.8). Pure: the page resolves the one database fact it may
// need (the kind of the expense a `q=BYA-...` names, see legacyExpenseNoQuery) and passes it in.
// Values are carried over verbatim; the target page parses them with its own rules, so a stale or
// hand-edited value falls back there exactly as it would on a fresh link.

type Raw = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The list params the old page understood (minus `group` and `tab`, which the menu replaces). */
const LIST_KEYS = ["month", "from", "to", "category", "voided", "q", "page", "perPage"] as const;
/** The old "Ringkasan" tab's period params. */
const SUMMARY_KEYS = ["period", "month", "from", "to"] as const;

/** An expense number as the activity log links it (`/ads-expenses?q=BYA-...`). */
const EXPENSE_NO = /^BYA-[A-Z0-9-]{1,40}$/i;

/** The `q` value worth looking up as an expense number, or undefined. Only on the list (the old
 * Ringkasan tab ignored `q`) and only without a `group`, which already names the menu. */
export function legacyExpenseNoQuery(raw: Raw): string | undefined {
  if (single(raw.tab) === "ringkasan" || legacyGroup(raw) !== undefined) return undefined;
  const q = single(raw.q)?.trim();
  return q && EXPENSE_NO.test(q) ? q.toUpperCase() : undefined;
}

function legacyGroup(raw: Raw): ExpenseCategoryGroup | undefined {
  const value = single(raw.group);
  return EXPENSE_CATEGORY_GROUPS.find((group) => group.key === value)?.key;
}

function withQuery(path: string, raw: Raw, keys: readonly string[], first?: [string, string]): string {
  const search = new URLSearchParams(first ? [first] : []);
  for (const key of keys) {
    const value = single(raw[key]);
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export interface LegacyRedirectContext {
  /** The catalog, inactive included (an old link may name a deactivated category). */
  categories: readonly Pick<ExpenseCategoryInfo, "code" | "kind">[];
  /** The expense legacyExpenseNoQuery named (its kind and month), or null when there is none or
   * it is unknown. */
  expense?: { kind: ExpenseCategoryKind; month: string } | null;
}

/**
 * The §3.8 redirect table:
 * - `?tab=ringkasan&...` -> Biaya "Laba rugi" (`/expenses?tab=pnl&...`), period params kept.
 * - `?group=marketing` -> `/ads`; `?group=operational` -> `/expenses` (a category of the other
 *   group is dropped, as the old page dropped it).
 * - `?category=<code>` -> the menu of the category's kind.
 * - `?q=BYA-...` -> the menu of that expense's kind, on its month (the list is per month) unless
 *   the link names a month or window itself; unknown -> `/expenses`.
 * - anything else -> `/expenses`.
 */
export function legacyAdsExpensesHref(raw: Raw, context: LegacyRedirectContext): string {
  if (single(raw.tab) === "ringkasan") return withQuery(expenseSummaryPath("pnl"), raw, SUMMARY_KEYS, ["tab", "pnl"]);

  const rawCategory = single(raw.category);
  const category = rawCategory === undefined ? undefined : findExpenseCategory(context.categories, rawCategory);
  const categoryGroup = category ? expenseGroupOfKind(category.kind) : undefined;
  const expenseGroup = context.expense ? expenseGroupOfKind(context.expense.kind) : undefined;
  const group = legacyGroup(raw) ?? categoryGroup ?? expenseGroup ?? "operational";
  // A category that belongs to the other menu (or is unknown) would only be dropped there; leave
  // it out so the new URL is clean.
  const keys = categoryGroup === group ? LIST_KEYS : LIST_KEYS.filter((key) => key !== "category");
  const datesGiven = ["month", "from", "to"].some((key) => Boolean(single(raw[key])));
  const expenseMonth: [string, string] | undefined = context.expense && !datesGiven ? ["month", context.expense.month] : undefined;
  return withQuery(expenseMenuPath(group), raw, keys, expenseMonth);
}

/** `/ads-expenses/report?...` -> `/expenses/report?...`, the query string unchanged. */
export function legacyReportHref(search: string): string {
  return `${EXPENSE_REPORT_PATH}${search}`;
}
