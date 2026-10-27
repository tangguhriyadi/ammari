import { BUSINESS_EXPENSE_CATEGORIES, type BusinessExpenseCategory } from "@ammari/db/schema";
import { calendarDaysBetween, isCalendarDate } from "@ammari/commerce/jakarta-day";
import { monthRange, monthToDate, shiftMonth, type DateRange } from "./figures";
import { EXPENSE_CATEGORY_GROUPS, type ExpenseCategoryGroup } from "./labels";

// The /ads-expenses list's URL (docs/plans/growth.md §6). Anything unknown falls back to the
// default instead of erroring: a hand-edited or stale link still shows a sensible page.

export interface ExpenseListParams {
  month: string;
  /** A date window instead of the month (`from`/`to`, e.g. the Gaji/Sewa reminder's 6th to 5th);
   * when set, `month` is ignored by the list. */
  range?: DateRange;
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
  return { month, range: parseListRange(raw, now), group, category, showVoided: single(raw.voided) === "1", q };
}

/** Longest `from`/`to` window the list accepts, both ends included. */
export const MAX_LIST_RANGE_DAYS = 366;
const MIN_LIST_DATE = "2000-01-01";

/** Real Jakarta dates, `from <= to <= today`, at most MAX_LIST_RANGE_DAYS; anything else is no
 * window (the month list). */
function parseListRange(raw: Raw, now: Date): DateRange | undefined {
  const from = single(raw.from);
  const to = single(raw.to);
  if (!isCalendarDate(from) || !isCalendarDate(to) || from < MIN_LIST_DATE) return undefined;
  if (from > to || to > monthToDate(now).to || calendarDaysBetween(from, to) + 1 > MAX_LIST_RANGE_DAYS) return undefined;
  return { from, to };
}

/** The list URL for these params; defaults are left out so the plain URL stays /ads-expenses. */
export function expenseListHref(params: ExpenseListParams, now: Date = new Date()): string {
  const search = new URLSearchParams();
  if (params.range) {
    search.set("from", params.range.from);
    search.set("to", params.range.to);
  } else if (params.month !== monthToDate(now).month) {
    search.set("month", params.month);
  }
  if (params.group) search.set("group", params.group);
  if (params.category) search.set("category", params.category);
  if (params.showVoided) search.set("voided", "1");
  if (params.q) search.set("q", params.q);
  const query = search.toString();
  return query ? `/ads-expenses?${query}` : "/ads-expenses";
}

// ---------- Tabs and the "Ringkasan" period (plan §4.2, §6) ----------

export type ExpenseTab = "expenses" | "summary";

/** "Pengeluaran" is the default; `?tab=ringkasan` is the summary. */
export function parseExpenseTab(raw: Raw): ExpenseTab {
  return single(raw.tab) === "ringkasan" ? "summary" : "expenses";
}

/** Whole months only (owner answer A3): a 7-day or one-day Laba bersih swings on the day Gaji or
 * Sewa is paid, so it is never offered. */
export const EXPENSE_SUMMARY_PERIODS = ["this_month", "last_month", "month", "range"] as const;
export type ExpenseSummaryPeriod = (typeof EXPENSE_SUMMARY_PERIODS)[number];
/** "Rentang bulan": at most this many months, both ends included. */
export const MAX_SUMMARY_MONTHS = 12;

export interface ExpenseSummaryParams {
  /** As asked for, so the month/range form stays open even when its value fell back. */
  period: ExpenseSummaryPeriod;
  fromMonth: string;
  toMonth: string;
  /** Inclusive Jakarta dates; this month ends today ("s.d. hari ini"). */
  range: DateRange;
  /** A month or range was sent but is invalid: this month is shown instead. */
  invalid: boolean;
}

const MONTH_PARAM = /^\d{4}-(0[1-9]|1[0-2])$/;
/** No real expense or order is older (records.ts MIN_EXPENSE_DATE). */
const MIN_SUMMARY_MONTH = "2000-01";

function monthsInclusive(fromMonth: string, toMonth: string): number {
  const index = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));
  return index(toMonth) - index(fromMonth) + 1;
}

/** Never throws on user input: anything unknown, malformed, reversed, too long or in the future
 * is this month. */
export function parseExpenseSummaryParams(raw: Raw, now: Date = new Date()): ExpenseSummaryParams {
  const today = monthToDate(now);
  const period = EXPENSE_SUMMARY_PERIODS.find((key) => key === single(raw.period)) ?? "this_month";
  const build = (fromMonth: string, toMonth: string, invalid = false): ExpenseSummaryParams => ({
    period,
    fromMonth,
    toMonth,
    range: { from: monthRange(fromMonth).from, to: toMonth === today.month ? today.to : monthRange(toMonth).to },
    invalid,
  });
  // The floor matches MIN_EXPENSE_DATE; it also keeps years 0000-0099 (which Date.UTC maps to
  // 19xx, so jakartaMidnight would throw) away from the queries.
  const valid = (month: string | undefined): month is string => month !== undefined && MONTH_PARAM.test(month) && month >= MIN_SUMMARY_MONTH && month <= today.month;

  switch (period) {
    case "this_month":
      return build(today.month, today.month);
    case "last_month": {
      const last = shiftMonth(today.month, -1);
      return build(last, last);
    }
    case "month": {
      const month = single(raw.month);
      if (valid(month)) return build(month, month);
      return build(today.month, today.month, month !== undefined && month !== "");
    }
    case "range": {
      const from = single(raw.from);
      const to = single(raw.to);
      if (valid(from) && valid(to) && from <= to && monthsInclusive(from, to) <= MAX_SUMMARY_MONTHS) return build(from, to);
      return build(today.month, today.month, Boolean(from || to));
    }
  }
}

/** The summary URL for a period; only the params that period needs. */
export function expenseSummaryHref({ period, fromMonth, toMonth }: { period: ExpenseSummaryPeriod; fromMonth?: string; toMonth?: string }): string {
  const search = new URLSearchParams({ tab: "ringkasan" });
  if (period !== "this_month") search.set("period", period);
  if (period === "month" && fromMonth) search.set("month", fromMonth);
  if (period === "range" && fromMonth && toMonth) {
    search.set("from", fromMonth);
    search.set("to", toMonth);
  }
  return `/ads-expenses?${search.toString()}`;
}
