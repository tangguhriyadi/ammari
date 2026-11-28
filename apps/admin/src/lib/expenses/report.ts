import "server-only";
import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { businessExpenses, expenseItems, staffUsers, type BusinessExpenseCategory, type BusinessExpenseMethod, type ChannelId } from "@ammari/db/schema";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import type { ExpenseCategoryInfo } from "@/lib/expense-categories/catalog";
import { getExpenseCategoryCatalog } from "@/lib/expense-categories/queries";
import { listCountedOrders, type CountedOrderRow } from "@/lib/overview/queries";
import type { ExpenseSummaryParams } from "./search-params";
import { dateRangeToTimeRange, getExpenseSummary, type ExpenseSummary } from "./summary";

// "Unduh laporan bulanan" on Biaya, tab Laba rugi (docs/plans/growth.md session S6,
// owner addition A): the tab's own figures (getExpenseSummary, so the file and the screen can
// never disagree) plus the rows behind them, for the PDF (report-pdf.ts) and the Excel file
// (report-xlsx.ts). Every figure is a cost figure: the route checks ads_expenses.manage +
// finance.view_profit before calling. No proof file and no customer data is ever read here.

/** More counted orders than this in one report is far beyond Ammari's volume (a year is a few
 * thousand); the Pesanan sheet stops there and says so instead of building an unbounded file. */
export const REPORT_ORDER_ROW_CAP = 50_000;

export interface ReportExpenseRow {
  expenseNo: string;
  expenseDate: string;
  category: BusinessExpenseCategory;
  /** The item's current name; null for an expense recorded without one. */
  itemName: string | null;
  channelId: ChannelId | null;
  campaign: string | null;
  amount: number;
  method: BusinessExpenseMethod;
  note: string | null;
  recordedByName: string | null;
}

export interface MonthlyReport {
  params: ExpenseSummaryParams;
  generatedAt: Date;
  summary: ExpenseSummary;
  /** The category catalog the labels come from (inactive included: a past expense keeps its name). */
  categories: ExpenseCategoryInfo[];
  /** Non-voided expenses of the range, by payment date (they add up to summary.expenses.total). */
  expenseRows: ReportExpenseRow[];
  orderRows: CountedOrderRow[];
  ordersTruncated: boolean;
}

/** Non-voided expenses paid in the range, oldest first: the same rows getExpenseBreakdown sums. */
async function listReportExpenses(params: ExpenseSummaryParams, db: Database): Promise<ReportExpenseRow[]> {
  const rows = await db
    .select({
      expenseNo: businessExpenses.expenseNo,
      expenseDate: businessExpenses.expenseDate,
      category: businessExpenses.category,
      itemName: sql<string | null>`${expenseItems.name}::text`,
      channelId: businessExpenses.channelId,
      campaign: businessExpenses.campaign,
      amount: businessExpenses.amount,
      method: businessExpenses.method,
      note: businessExpenses.note,
      recordedByName: staffUsers.name,
    })
    .from(businessExpenses)
    .leftJoin(expenseItems, eq(expenseItems.id, businessExpenses.itemId))
    .leftJoin(staffUsers, eq(staffUsers.id, businessExpenses.recordedByStaffUserId))
    .where(and(isNull(businessExpenses.voidedAt), gte(businessExpenses.expenseDate, params.range.from), lte(businessExpenses.expenseDate, params.range.to)))
    .orderBy(asc(businessExpenses.expenseDate), asc(businessExpenses.createdAt), asc(businessExpenses.expenseNo));
  return rows.map((row) => ({ ...row, channelId: row.channelId as ChannelId | null }));
}

export async function getMonthlyReport(params: ExpenseSummaryParams, now: Date = new Date(), db: Database = defaultDb): Promise<MonthlyReport> {
  const [summary, expenseRows, orders, catalog] = await Promise.all([
    getExpenseSummary(params.range, now, db),
    listReportExpenses(params, db),
    listCountedOrders(dateRangeToTimeRange(params.range, now), REPORT_ORDER_ROW_CAP, db),
    getExpenseCategoryCatalog(db),
  ]);
  return { params, generatedAt: now, summary, categories: catalog.categories, expenseRows, orderRows: orders.rows, ordersTruncated: orders.truncated };
}

export type ReportFormat = "pdf" | "xlsx";

/** The download is audited (owner addition A): the period, the format and the row counts, never
 * a figure or a row. */
export async function recordMonthlyReportDownload(actorStaffUserId: string, report: MonthlyReport, format: ReportFormat, db: Database = defaultDb): Promise<void> {
  await writeAuditLog(db, {
    actorStaffUserId,
    action: "download",
    entityType: "expense_report",
    entityId: `${report.params.fromMonth}..${report.params.toMonth}`,
    after: {
      format,
      fromMonth: report.params.fromMonth,
      toMonth: report.params.toMonth,
      expenseRows: report.expenseRows.length,
      // Refund-only rows (Q19) are not orders.
      orderRows: report.orderRows.filter((row) => !row.refundOnly).length,
      ordersTruncated: report.ordersTruncated,
    },
  });
}
