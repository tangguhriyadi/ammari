import { BUSINESS_EXPENSE_CATEGORIES, type BusinessExpenseCategory } from "@ammari/db/schema";
import { monthToDate } from "./figures";
import { EXPENSE_CATEGORY_GROUPS, type ExpenseCategoryGroup } from "./labels";

// The /ads-expenses list's URL (docs/plans/growth.md §6). Anything unknown falls back to the
// default instead of erroring: a hand-edited or stale link still shows a sensible page.

export interface ExpenseListParams {
  month: string;
  group?: ExpenseCategoryGroup;
  category?: BusinessExpenseCategory;
  showVoided: boolean;
  q?: string;
}

type Raw = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Month defaults to this Jakarta month; a malformed or future month does too. A category that
 * is not in the chosen group is dropped, so the two filters can never contradict each other. */
export function parseExpenseListParams(raw: Raw, now: Date = new Date()): ExpenseListParams {
  const current = monthToDate(now).month;
  const rawMonth = single(raw.month);
  const month = rawMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth) && rawMonth <= current ? rawMonth : current;
  const group = EXPENSE_CATEGORY_GROUPS.find((entry) => entry.key === single(raw.group))?.key;
  const rawCategory = single(raw.category);
  let category = BUSINESS_EXPENSE_CATEGORIES.find((key) => key === rawCategory);
  if (category && group && !(EXPENSE_CATEGORY_GROUPS.find((entry) => entry.key === group)!.categories as readonly string[]).includes(category)) category = undefined;
  const q = single(raw.q)?.trim().slice(0, 100) || undefined;
  return { month, group, category, showVoided: single(raw.voided) === "1", q };
}

/** The list URL for these params; defaults are left out so the plain URL stays /ads-expenses. */
export function expenseListHref(params: ExpenseListParams, now: Date = new Date()): string {
  const search = new URLSearchParams();
  if (params.month !== monthToDate(now).month) search.set("month", params.month);
  if (params.group) search.set("group", params.group);
  if (params.category) search.set("category", params.category);
  if (params.showVoided) search.set("voided", "1");
  if (params.q) search.set("q", params.q);
  const query = search.toString();
  return query ? `/ads-expenses?${query}` : "/ads-expenses";
}
