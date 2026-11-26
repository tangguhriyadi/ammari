import type { BusinessExpenseCategory } from "@ammari/db/schema";
import { calendarDaysBetween, isCalendarDate } from "@ammari/commerce/jakarta-day";
import { expenseGroupOfKind, findExpenseCategory, type ExpenseCategoryInfo } from "@/lib/expense-categories/catalog";
import { monthRange, monthToDate, shiftMonth, type DateRange } from "./figures";
import { MARKETING_CHANNEL_OPTIONS, type ExpenseCategoryGroup, type MarketingChannelId } from "./labels";

// The URLs of the two expense menus (docs/plans/expense-master-data.md §3.8): "Iklan" (/ads, kinds
// ad + endorsement) and "Biaya" (/expenses, kind operating). The menu IS the group: a list is
// always scoped to one. Anything unknown falls back to the default instead of erroring, so a
// hand-edited or stale link still shows a sensible page.

/** The menu of each group. */
export const EXPENSE_MENU_PATHS = {
  marketing: "/ads",
  operational: "/expenses",
} as const satisfies Record<ExpenseCategoryGroup, string>;

export type ExpenseMenuPath = (typeof EXPENSE_MENU_PATHS)[ExpenseCategoryGroup];

export function expenseMenuPath(group: ExpenseCategoryGroup): ExpenseMenuPath {
  return EXPENSE_MENU_PATHS[group];
}

export interface ExpenseListParams {
  month: string;
  /** A date window instead of the month (`from`/`to`, e.g. the Gaji/Sewa reminder's 6th to 5th);
   * when set, `month` is ignored by the list. */
  range?: DateRange;
  /** The menu: Iklan ("marketing") or Biaya ("operational"). */
  group: ExpenseCategoryGroup;
  category?: BusinessExpenseCategory;
  /** Iklan only: "Kanal". */
  channelId?: MarketingChannelId;
  showVoided: boolean;
  q?: string;
}

type Raw = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Month defaults to this Jakarta month; a malformed or future month does too. `categories` is the
 * catalog (inactive included: past expenses can still be filtered by one). An unknown category, or
 * one whose kind belongs to the other menu, is dropped, so the menu and the filter can never
 * contradict each other. A channel only exists on Iklan. */
export function parseExpenseListParams(
  raw: Raw,
  categories: readonly Pick<ExpenseCategoryInfo, "code" | "kind">[],
  group: ExpenseCategoryGroup,
  now: Date = new Date(),
): ExpenseListParams {
  const current = monthToDate(now).month;
  const rawMonth = single(raw.month);
  const month = rawMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth) && rawMonth <= current ? rawMonth : current;
  const rawCategory = single(raw.category);
  const found = rawCategory === undefined ? undefined : findExpenseCategory(categories, rawCategory);
  const category = found && expenseGroupOfKind(found.kind) === group ? found.code : undefined;
  const rawChannel = single(raw.channel);
  const channelId = group === "marketing" ? MARKETING_CHANNEL_OPTIONS.find((key) => key === rawChannel) : undefined;
  const q = single(raw.q)?.trim().slice(0, 100) || undefined;
  return { month, range: parseListRange(raw, now), group, category, channelId, showVoided: single(raw.voided) === "1", q };
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

/** The list URL for these params, on the group's menu; defaults are left out so the plain URL
 * stays /ads or /expenses. */
export function expenseListHref(params: ExpenseListParams, now: Date = new Date()): string {
  const search = new URLSearchParams();
  if (params.range) {
    search.set("from", params.range.from);
    search.set("to", params.range.to);
  } else if (params.month !== monthToDate(now).month) {
    search.set("month", params.month);
  }
  if (params.category) search.set("category", params.category);
  if (params.channelId && params.group === "marketing") search.set("channel", params.channelId);
  if (params.showVoided) search.set("voided", "1");
  if (params.q) search.set("q", params.q);
  const query = search.toString();
  const path = expenseMenuPath(params.group);
  return query ? `${path}?${query}` : path;
}

// ---------- Tabs and the summary period (plan §4.2, §6; expense-master-data.md §3.8) ----------

/** Iklan: "Catatan iklan" (default) or "ROAS" (`?tab=roas`). */
export type AdsTab = "list" | "roas";
/** Biaya: "Biaya operasional" (default), "Pengeluaran produksi" (`?tab=production`, read-only,
 * session S6) or "Laba rugi" (`?tab=pnl`). */
export type ExpensesTab = "list" | "production" | "pnl";
/** The two tabs that show getExpenseSummary for a whole-month period. */
export type ExpenseSummaryView = "roas" | "pnl";

export function parseAdsTab(raw: Raw): AdsTab {
  return single(raw.tab) === "roas" ? "roas" : "list";
}

export function parseExpensesTab(raw: Raw): ExpensesTab {
  const tab = single(raw.tab);
  return tab === "pnl" || tab === "production" ? tab : "list";
}

/** The menu that hosts a summary view: ROAS on Iklan, Laba rugi on Biaya (owner answer D8). */
export function expenseSummaryPath(view: ExpenseSummaryView): ExpenseMenuPath {
  return view === "roas" ? EXPENSE_MENU_PATHS.marketing : EXPENSE_MENU_PATHS.operational;
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

/** The summary URL for a period, on Biaya's "Laba rugi" (default) or Iklan's "ROAS"; only the
 * params that period needs. */
export function expenseSummaryHref(
  { period, fromMonth, toMonth }: { period: ExpenseSummaryPeriod; fromMonth?: string; toMonth?: string },
  view: ExpenseSummaryView = "pnl",
): string {
  const search = new URLSearchParams({ tab: view });
  if (period !== "this_month") search.set("period", period);
  if (period === "month" && fromMonth) search.set("month", fromMonth);
  if (period === "range" && fromMonth && toMonth) {
    search.set("from", fromMonth);
    search.set("to", toMonth);
  }
  return `${expenseSummaryPath(view)}?${search.toString()}`;
}

/** The monthly report route (Biaya, owner answer D8). `/ads-expenses/report` redirects here. */
export const EXPENSE_REPORT_PATH = "/expenses/report";

/** "Unduh laporan bulanan" (session S6): the report route for exactly the period shown, so the
 * file and the screen read the same params through the same parser. */
export function expenseReportHref(params: Pick<ExpenseSummaryParams, "period" | "fromMonth" | "toMonth">, format: "pdf" | "xlsx"): string {
  const search = new URLSearchParams({ format });
  // Whatever was shown is sent as an explicit month or range, so a report opened just after
  // midnight on the 1st still describes the month the screen showed.
  if (params.fromMonth === params.toMonth) {
    search.set("period", "month");
    search.set("month", params.fromMonth);
  } else {
    search.set("period", "range");
    search.set("from", params.fromMonth);
    search.set("to", params.toMonth);
  }
  return `${EXPENSE_REPORT_PATH}?${search.toString()}`;
}

// ---------- "Pengeluaran produksi" and the cash summary (expense-master-data.md §3.9, §3.10) ----------

export const PRODUCTION_OUTFLOW_SOURCES = ["purchase", "production"] as const;
export type ProductionOutflowSourceFilter = (typeof PRODUCTION_OUTFLOW_SOURCES)[number];

export interface ProductionOutflowParams {
  month: string;
  /** "Sumber": Pembelian or Produksi; undefined is Semua. */
  source?: ProductionOutflowSourceFilter;
  q?: string;
}

/** A whole Jakarta month that has started (default and fallback: this month). */
function parseMonthParam(value: string | undefined, now: Date): string {
  const current = monthToDate(now).month;
  return value && MONTH_PARAM.test(value) && value >= MIN_SUMMARY_MONTH && value <= current ? value : current;
}

/** Never throws on user input: anything unknown falls back to this month, every source, no
 * search. */
export function parseProductionOutflowParams(raw: Raw, now: Date = new Date()): ProductionOutflowParams {
  const rawSource = single(raw.source);
  const source = PRODUCTION_OUTFLOW_SOURCES.find((key) => key === rawSource);
  const q = single(raw.q)?.trim().slice(0, 100) || undefined;
  return { month: parseMonthParam(single(raw.month), now), source, q };
}

/** The tab's URL; this month is left out, like expenseListHref. */
export function productionOutflowHref(params: ProductionOutflowParams, now: Date = new Date()): string {
  const search = new URLSearchParams({ tab: "production" });
  if (params.month !== monthToDate(now).month) search.set("month", params.month);
  if (params.source) search.set("source", params.source);
  if (params.q) search.set("q", params.q);
  return `${EXPENSE_MENU_PATHS.operational}?${search.toString()}`;
}

/** The month "Arus kas keluar" shows, following the tab below it: the list's month (or the last
 * month of its date window), the production tab's month, or the last month of Laba rugi's
 * period. */
export function cashSummaryMonth(raw: Raw, tab: ExpensesTab, now: Date = new Date()): string {
  if (tab === "pnl") return parseExpenseSummaryParams(raw, now).toMonth;
  if (tab === "production") return parseProductionOutflowParams(raw, now).month;
  const list = parseExpenseListParams(raw, [], "operational", now);
  return list.range ? list.range.to.slice(0, 7) : list.month;
}
