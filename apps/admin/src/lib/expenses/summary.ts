import "server-only";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { businessExpenses, expenseCategories, type BusinessExpenseCategory, type ChannelId } from "@ammari/db/schema";
import { addCalendarDays, jakartaMidnight } from "@ammari/commerce/jakarta-day";
import { defaultDb, type Database } from "@/lib/db";
import { getMonthlyBillCategories } from "@/lib/settings/monthly-bills";
import type { TimeRange } from "@/lib/overview/period";
import { getChannelBreakdown, getPeriodTotals, type ChannelBreakdownRow, type PeriodMoney, type PeriodTotals } from "@/lib/overview/queries";
import {
  breakEvenRoas,
  buildRoasRows,
  labaBersih,
  monthlyBillsReminderWindow,
  summarizeMarketing,
  type BreakEvenRoas,
  type DateRange,
  type MarketingSummary,
  type MonthlyBillsWindow,
  type RoasRow,
} from "./figures";

// "Iklan & Biaya" figures read from the database (docs/plans/growth.md §4, session S3). Every
// number here is a cost figure: callers check ads_expenses.manage / finance.view_profit on the
// session BEFORE calling (the summary tab, the Laba bersih tile, the Perlu tindakan item), so a
// viewer without them never triggers a query and never receives a field. Omzet, laba and the web
// shipping subsidy come from lib/overview (getPeriodTotals, getChannelBreakdown): one definition.

/** Jakarta dates as the half-open instant range orders are filtered by: from 00:00 WIB on the
 * first day to 00:00 WIB after the last, stopped at `now` for a range that ends today. */
export function dateRangeToTimeRange(range: DateRange, now: Date = new Date()): TimeRange {
  return {
    start: jakartaMidnight(range.from),
    end: new Date(Math.min(jakartaMidnight(addCalendarDays(range.to, 1)).getTime(), now.getTime())),
  };
}

function toAmount(value: string | number | null | undefined): number {
  const amount = Number(value ?? 0);
  if (!Number.isSafeInteger(amount)) throw new Error("expense amount overflow");
  return amount;
}

export interface ExpenseCategoryTotal {
  category: BusinessExpenseCategory;
  amount: number;
}

export interface ExpenseBreakdown {
  /** Every non-voided expense paid in the range (plan §4.1 `expenses(range)`). */
  total: number;
  /** Only categories with spend, biggest first (ties in the categories' sort_order, then code). */
  byCategory: ExpenseCategoryTotal[];
  marketing: MarketingSummary;
}

/** Non-voided expenses by payment date (cash basis, owner answer A3), grouped by category and
 * channel: one small aggregate over business_expenses_expense_date_created_at_idx, joined to
 * expense_categories for each category's kind (what ROAS and the Endorse line read) and its
 * sort_order (the tie-break). Reads business_expenses ONLY: supplier payments (purchases,
 * production) reach Laba bersih solely as HPP of sold orders (expense-master-data.md §3.11). */
export async function getExpenseBreakdown(range: DateRange, db: Database = defaultDb): Promise<ExpenseBreakdown> {
  const rows = await db
    .select({
      category: businessExpenses.category,
      kind: expenseCategories.kind,
      sortOrder: expenseCategories.sortOrder,
      channelId: businessExpenses.channelId,
      amount: sql<string>`sum(${businessExpenses.amount})::text`,
    })
    .from(businessExpenses)
    .innerJoin(expenseCategories, eq(expenseCategories.code, businessExpenses.category))
    .where(and(isNull(businessExpenses.voidedAt), gte(businessExpenses.expenseDate, range.from), lte(businessExpenses.expenseDate, range.to)))
    .groupBy(businessExpenses.category, expenseCategories.kind, expenseCategories.sortOrder, businessExpenses.channelId);

  const figures = rows.map((row) => ({ kind: row.kind, channelId: row.channelId as ChannelId | null, amount: toAmount(row.amount), voided: false }));
  const perCategory = new Map<BusinessExpenseCategory, { amount: number; sortOrder: number }>();
  rows.forEach((row, index) => {
    const entry = perCategory.get(row.category) ?? { amount: 0, sortOrder: row.sortOrder };
    entry.amount += figures[index]!.amount;
    perCategory.set(row.category, entry);
  });
  const byCategory = [...perCategory.entries()]
    .sort(([codeA, a], [codeB, b]) => b.amount - a.amount || a.sortOrder - b.sortOrder || (codeA < codeB ? -1 : codeA > codeB ? 1 : 0))
    .map(([category, { amount }]) => ({ category, amount }));
  return {
    total: byCategory.reduce((sum, entry) => sum + entry.amount, 0),
    byCategory,
    marketing: summarizeMarketing(figures),
  };
}

/** Just the total of getExpenseBreakdown, for the Ringkasan tile. Category-agnostic, and like it
 * never reads supplier_payments. */
export async function getExpenseTotal(range: DateRange, db: Database = defaultDb): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${businessExpenses.amount}), 0)::text` })
    .from(businessExpenses)
    .where(and(isNull(businessExpenses.voidedAt), gte(businessExpenses.expenseDate, range.from), lte(businessExpenses.expenseDate, range.to)));
  return toAmount(row?.total);
}

export interface ExpenseSummary {
  totals: PeriodTotals;
  money: PeriodMoney;
  channels: ChannelBreakdownRow[];
  expenses: ExpenseBreakdown;
  /** Laba bersih (plan §4.1). */
  net: number;
  /** HPP or platform fees are missing for some counted order: every laba, and the break-even
   * ROAS, is higher than the truth. */
  incomplete: boolean;
  breakEven: BreakEvenRoas;
  roasRows: RoasRow[];
}

/** Every figure of the "Ringkasan" tab for a range of whole months. The tab and "Unduh laporan
 * bulanan" (report.ts) both read this one function, so the downloaded numbers are the screen's.
 * Callers have checked ads_expenses.manage + finance.view_profit (hence canViewProfit: true). */
export async function getExpenseSummary(range: DateRange, now: Date = new Date(), db: Database = defaultDb): Promise<ExpenseSummary> {
  const time = dateRangeToTimeRange(range, now);
  const [totals, channels, expenses] = await Promise.all([
    getPeriodTotals(time, { canViewProfit: true }, db),
    getChannelBreakdown(time, { canViewProfit: true }, db),
    getExpenseBreakdown(range, db),
  ]);
  const money = totals.money;
  if (!money) throw new Error("expense summary needs the money totals");
  const breakEven = breakEvenRoas(money);
  return {
    totals,
    money,
    channels,
    expenses,
    net: labaBersih({ labaSetelahBiayaPlatform: money.labaSetelahBiayaPlatform, webShippingSubsidy: money.webShippingSubsidy, expenses: expenses.total }),
    incomplete: money.linesWithoutCost > 0 || money.platformFees.ordersWithoutFees > 0,
    breakEven,
    roasRows: buildRoasRows(expenses.marketing, new Map(channels.map((channel) => [channel.channelId, channel.omzet ?? 0])), breakEven),
  };
}

export type MonthlyBillsReminder =
  /** No category chosen on /settings: the item is not shown at all. */
  | { state: "off" }
  /** Chosen, and nothing missing (or before the 6th). */
  | { state: "ok"; categories: BusinessExpenseCategory[] }
  | (MonthlyBillsWindow & {
      state: "missing";
      /** The chosen categories with no non-voided expense in the window, in their saved order. */
      missing: BusinessExpenseCategory[];
    });

/** The "biaya bulanan belum dicatat" item (owner answer A6): from the 6th, last month's bills,
 * one per category chosen on /settings ("Pengingat biaya bulanan"), each needing its own
 * non-voided expense paid (Jakarta date) between the 6th of last month and the 5th of this one. */
export async function getMonthlyBillsReminder(now: Date = new Date(), db: Database = defaultDb): Promise<MonthlyBillsReminder> {
  const chosen = await getMonthlyBillCategories(db);
  if (chosen.length === 0) return { state: "off" };
  // A category deactivated after it was chosen can no longer be recorded, so it is never asked
  // for (expense-master-data.md §3.5). All of them inactive: the reminder is off.
  const active = new Set(
    (
      await db
        .select({ code: expenseCategories.code })
        .from(expenseCategories)
        .where(and(inArray(expenseCategories.code, chosen), eq(expenseCategories.isActive, true)))
    ).map((row) => row.code),
  );
  const categories = chosen.filter((category) => active.has(category));
  if (categories.length === 0) return { state: "off" };
  const window = monthlyBillsReminderWindow(now);
  if (!window) return { state: "ok", categories };
  // Spelled like business_expenses_category_expense_date_idx.
  const rows = await db
    .selectDistinct({ category: businessExpenses.category })
    .from(businessExpenses)
    .where(
      and(
        inArray(businessExpenses.category, categories),
        gte(businessExpenses.expenseDate, window.from),
        lte(businessExpenses.expenseDate, window.to),
        isNull(businessExpenses.voidedAt),
      ),
    );
  const recorded = new Set<string>(rows.map((row) => row.category));
  const missing = categories.filter((category) => !recorded.has(category));
  return missing.length > 0 ? { state: "missing", ...window, missing } : { state: "ok", categories };
}
