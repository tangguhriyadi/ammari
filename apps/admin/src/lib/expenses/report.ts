import "server-only";
import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { businessExpenses, staffUsers, type BusinessExpenseCategory, type BusinessExpenseMethod, type ChannelId } from "@ammari/db/schema";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { listCountedOrders, type CountedOrderRow } from "@/lib/overview/queries";
import type { ExpenseSummaryParams } from "./search-params";
import { dateRangeToTimeRange, getExpenseSummary, type ExpenseSummary } from "./summary";

// "Unduh laporan bulanan" on the Iklan & Biaya Ringkasan tab (docs/plans/growth.md session S6,
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
      channelId: businessExpenses.channelId,
      campaign: businessExpenses.campaign,
      amount: businessExpenses.amount,
      method: businessExpenses.method,
      note: businessExpenses.note,
      recordedByName: staffUsers.name,
    })
    .from(businessExpenses)
    .leftJoin(staffUsers, eq(staffUsers.id, businessExpenses.recordedByStaffUserId))
    .where(and(isNull(businessExpenses.voidedAt), gte(businessExpenses.expenseDate, params.range.from), lte(businessExpenses.expenseDate, params.range.to)))
    .orderBy(asc(businessExpenses.expenseDate), asc(businessExpenses.createdAt), asc(businessExpenses.expenseNo));
  return rows.map((row) => ({ ...row, channelId: row.channelId as ChannelId | null }));
}

export async function getMonthlyReport(params: ExpenseSummaryParams, now: Date = new Date(), db: Database = defaultDb): Promise<MonthlyReport> {
  const [summary, expenseRows, orders] = await Promise.all([
    getExpenseSummary(params.range, now, db),
    listReportExpenses(params, db),
    listCountedOrders(dateRangeToTimeRange(params.range, now), REPORT_ORDER_ROW_CAP, db),
  ]);
  return { params, generatedAt: now, summary, expenseRows, orderRows: orders.rows, ordersTruncated: orders.truncated };
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
      orderRows: report.orderRows.length,
      ordersTruncated: report.ordersTruncated,
    },
  });
}
