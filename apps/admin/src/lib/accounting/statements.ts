import "server-only";
import { sql } from "drizzle-orm";
import { bookSegmentOf, monthStartOf, nextMonthStart, OFFICIAL_BOOKS_START, resolveReportRange, segmentStartOf, type BookSegment, type ReportRange } from "@ammari/accounting";
import type { AccountType, CashFlowGroup } from "@ammari/db/schema";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { CHANNEL_DISPLAY_NAMES } from "@/lib/orders/channel-label";
import type { DateRange, IncomeStatementView } from "./filters";
import { formatDay } from "./format";
import {
  allocateCashFlow,
  buildBalanceSheet,
  buildCashFlowStatement,
  buildIncomeStatement,
  type BalanceSheetFigures,
  type CashFlowFigures,
  type IncomeStatementFigures,
  type Statement,
  type StatementAccount,
  type StatementColumn,
} from "./statement-layout";
import { IS_CLOSING_SQL, IS_OPENING_SQL } from "./trial-balance";

// Neraca, Laba rugi and Arus kas (docs/plans/accounting.md §6, Session 10): the database half.
// Every figure is summed within ONE set of books (books.ts, plan §5.4): from 1 Dec 2026 for the
// December trial month, from the cut-over 1 Jan 2027 for the official books, so a trial-month
// journal never reaches a 2027 statement. In the official books the opening journal (and a reversal
// of it) is the opening balance, never a movement of January: it is in the Neraca's balances and the
// Arus kas's opening cash, never in Laba rugi or in a period's cash flows. Entries are dated by
// entry_date, exactly as Neraca saldo and Buku besar, so the statements tie out to them.


function num(value: string | number | null | undefined): number {
  const amount = Number(value ?? 0);
  // A report never prints a rounded figure.
  if (!Number.isSafeInteger(amount)) throw new Error("accounting report amount overflow");
  return amount;
}

export async function loadStatementAccounts(db: Database): Promise<StatementAccount[]> {
  const rows = (await db.execute(sql`
    select code, name::text as name, type, parent_code, is_header, is_active, cash_flow_group
    from accounts order by sort_order, code
  `)) as unknown as { code: string; name: string; type: AccountType; parent_code: string | null; is_header: boolean; is_active: boolean; cash_flow_group: CashFlowGroup }[];
  return rows.map((row) => ({ code: row.code, name: row.name, type: row.type, parentCode: row.parent_code, isHeader: row.is_header, isActive: row.is_active, cashFlowGroup: row.cash_flow_group }));
}

/** Σ debit − credit per account for entries dated in [segmentStart, asOf] (opening included). */
async function balancesThrough(db: Database, segmentStart: string, asOf: string, openingOnly = false): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    select l.account_code, sum(l.debit - l.credit)::bigint as net
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    left join journal_entries reversed on reversed.id = e.reverses_entry_id
    where e.entry_date >= ${segmentStart} and e.entry_date <= ${asOf} ${openingOnly ? sql`and ${IS_OPENING_SQL}` : sql``}
    group by l.account_code
  `)) as unknown as { account_code: string; net: string }[];
  return new Map(rows.map((row) => [row.account_code, num(row.net)]));
}

function columnsMap(maps: Map<string, number>[]): Map<string, number[]> {
  const result = new Map<string, number[]>();
  maps.forEach((map, index) => {
    for (const [code, value] of map) {
      const values = result.get(code) ?? maps.map(() => 0);
      values[index] = value;
      result.set(code, values);
    }
  });
  return result;
}

// ---------- Neraca ----------

export type Comparison = { kind: "date"; asOf: string } | { kind: "opening"; asOf: string } | { kind: "none" };

/** What the Neraca is compared to: the end of the previous month in the same set of books. In
 * January 2027 that is the official opening balance (1 Jan 2027), never 31 Dec 2026 (the trial
 * books); the trial month has nothing to compare to. */
export function balanceSheetComparison(asOf: string): Comparison {
  const segment = bookSegmentOf(asOf);
  if (segment !== "official") return { kind: "none" };
  const previousMonthEnd = dayBefore(monthStartOf(asOf));
  if (previousMonthEnd < OFFICIAL_BOOKS_START) return { kind: "opening", asOf: OFFICIAL_BOOKS_START };
  return { kind: "date", asOf: previousMonthEnd };
}

/** "2027-01-01" -> "2026-12-31". */
export function dayBefore(date: string): string {
  const ms = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) - 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

export interface BalanceSheetReport {
  kind: "balance_sheet";
  asOf: string;
  segment: BookSegment;
  segmentStart: string;
  comparison: Comparison;
  statement: Statement & { figures: BalanceSheetFigures };
  generatedAt: Date;
}

export async function getBalanceSheet(asOf: string, db: Database = defaultDb, now: Date = new Date()): Promise<BalanceSheetReport> {
  const segment = bookSegmentOf(asOf);
  const segmentStart = segmentStartOf(asOf);
  const comparison = balanceSheetComparison(asOf);
  const [accounts, current, previous] = await Promise.all([
    loadStatementAccounts(db),
    balancesThrough(db, segmentStart, asOf),
    comparison.kind === "none" ? Promise.resolve(null) : balancesThrough(db, segmentStart, comparison.asOf, comparison.kind === "opening"),
  ]);
  const columns: StatementColumn[] = [{ key: asOf, label: formatDay(asOf) }];
  if (comparison.kind === "date") columns.push({ key: comparison.asOf, label: formatDay(comparison.asOf) });
  if (comparison.kind === "opening") columns.push({ key: "opening", label: `Saldo awal ${formatDay(comparison.asOf)}` });
  const statement = buildBalanceSheet(accounts, columnsMap(previous ? [current, previous] : [current]), columns);
  return { kind: "balance_sheet", asOf, segment, segmentStart, comparison, statement, generatedAt: now };
}

// ---------- Laba rugi ----------

export type { IncomeStatementView } from "./filters";

export interface IncomeStatementReport {
  kind: "income_statement";
  range: ReportRange;
  view: IncomeStatementView;
  /** "Per bulan" over more than MAX_MONTH_COLUMNS months: the range was shortened. */
  monthsClamped: boolean;
  statement: Statement & { figures: IncomeStatementFigures };
  generatedAt: Date;
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const monthLabel = (month: string) => `${MONTH_LABELS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
/** Lines without a channel (most expenses, manual journals). */
export const NO_CHANNEL_KEY = "none";

/** Σ debit − credit per account (and per column key) for the period's movements: entries dated
 * in [from, to], neither the opening balance nor a year-end closing. */
async function periodMovements(db: Database, range: ReportRange, view: IncomeStatementView) {
  const columnKey =
    view === "month" ? sql`to_char(e.entry_date, 'YYYY-MM')` : view === "channel" ? sql`coalesce(l.channel_id, ${NO_CHANNEL_KEY})` : sql`'total'`;
  return (await db.execute(sql`
    select l.account_code, ${columnKey} as column_key, sum(l.debit - l.credit)::bigint as net
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    left join journal_entries reversed on reversed.id = e.reverses_entry_id
    where e.entry_date >= ${range.from} and e.entry_date <= ${range.to} and not ${IS_OPENING_SQL} and not ${IS_CLOSING_SQL}
    group by l.account_code, column_key
  `)) as unknown as { account_code: string; column_key: string; net: string }[];
}

async function channelColumns(db: Database, used: ReadonlySet<string>): Promise<StatementColumn[]> {
  const rows = (await db.execute(sql`select id, name from channels order by id`)) as unknown as { id: string; name: string }[];
  const columns = rows.filter((row) => used.has(row.id)).map((row) => ({ key: row.id, label: CHANNEL_DISPLAY_NAMES[row.id] ?? row.name }));
  if (used.has(NO_CHANNEL_KEY)) columns.push({ key: NO_CHANNEL_KEY, label: "Tanpa saluran" });
  return columns;
}

function monthColumns(range: ReportRange): StatementColumn[] {
  const columns: StatementColumn[] = [];
  for (let month = monthStartOf(range.from); month <= range.to; month = nextMonthStart(month)) columns.push({ key: month.slice(0, 7), label: monthLabel(month) });
  return columns;
}

/** "Per bulan" shows at most this many month columns: a longer range starts this many months
 * before its last month (a page or file with hundreds of columns is useless). */
export const MAX_MONTH_COLUMNS = 12;

/** The first day `MAX_MONTH_COLUMNS` months back from `to`'s month, or `from` when later. */
export function clampMonthRange(range: DateRange): DateRange {
  let start = monthStartOf(range.to);
  for (let index = 1; index < MAX_MONTH_COLUMNS; index += 1) start = monthStartOf(dayBefore(start));
  return range.from < start ? { from: start, to: range.to } : range;
}

export async function getIncomeStatement(requested: DateRange, view: IncomeStatementView = "total", db: Database = defaultDb, now: Date = new Date()): Promise<IncomeStatementReport> {
  const monthsClamped = view === "month" && clampMonthRange(requested).from !== requested.from;
  const range = resolveReportRange(view === "month" ? clampMonthRange(requested) : requested);
  const [accounts, rows] = await Promise.all([loadStatementAccounts(db), periodMovements(db, range, view)]);
  let columns: StatementColumn[];
  if (view === "total") columns = [{ key: "total", label: "Jumlah" }];
  else {
    const parts = view === "month" ? monthColumns(range) : await channelColumns(db, new Set(rows.map((row) => row.column_key)));
    columns = [...parts, { key: "total", label: "Jumlah" }];
  }
  const index = new Map(columns.map((column, position) => [column.key, position]));
  const totalIndex = columns.length - 1;
  const movements = new Map<string, number[]>();
  for (const row of rows) {
    const values = movements.get(row.account_code) ?? columns.map(() => 0);
    const position = index.get(row.column_key);
    if (view !== "total" && position !== undefined) values[position]! += num(row.net);
    values[totalIndex]! += num(row.net);
    movements.set(row.account_code, values);
  }
  return { kind: "income_statement", range, view, monthsClamped, statement: buildIncomeStatement(accounts, movements, columns), generatedAt: now };
}

// ---------- Arus kas ----------

export interface CashFlowReport {
  kind: "cash_flow";
  range: ReportRange;
  statement: Statement & { figures: CashFlowFigures };
  generatedAt: Date;
}

export async function getCashFlow(requested: DateRange, db: Database = defaultDb, now: Date = new Date()): Promise<CashFlowReport> {
  const range = resolveReportRange(requested);
  const [accounts, lines, opening, closing] = await Promise.all([
    loadStatementAccounts(db),
    db.execute(sql`
      select l.entry_id::text as entry_id, l.account_code, (l.debit - l.credit)::bigint as net
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      left join journal_entries reversed on reversed.id = e.reverses_entry_id
      where e.entry_date >= ${range.from} and e.entry_date <= ${range.to} and not ${IS_OPENING_SQL}
        and exists (select 1 from journal_lines c join accounts ca on ca.code = c.account_code where c.entry_id = e.id and ca.cash_flow_group = 'cash')
    `) as unknown as Promise<{ entry_id: string; account_code: string; net: string }[]>,
    // Opening cash: everything in the set of books before `from`, plus the opening journal.
    db.execute(sql`
      select l.account_code, sum(l.debit - l.credit)::bigint as net
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      left join journal_entries reversed on reversed.id = e.reverses_entry_id
      join accounts a on a.code = l.account_code and a.cash_flow_group = 'cash'
      where e.entry_date >= ${range.segmentStart} and e.entry_date <= ${range.to} and (e.entry_date < ${range.from} or ${IS_OPENING_SQL})
      group by l.account_code
    `) as unknown as Promise<{ account_code: string; net: string }[]>,
    balancesThrough(db, range.segmentStart, range.to),
  ]);
  const accountInfo = new Map(accounts.map((account) => [account.code, account]));
  const allocation = allocateCashFlow(
    lines.map((line) => ({ entryId: line.entry_id, accountCode: line.account_code, net: num(line.net) })),
    accountInfo,
  );
  const openingByCode = new Map(opening.map((row) => [row.account_code, num(row.net)]));
  const cashBalances = new Map<string, [number, number]>();
  for (const account of accounts) {
    if (account.cashFlowGroup !== "cash" || account.isHeader) continue;
    cashBalances.set(account.code, [openingByCode.get(account.code) ?? 0, closing.get(account.code) ?? 0]);
  }
  const column = { key: "total", label: "Jumlah" };
  return { kind: "cash_flow", range, statement: buildCashFlowStatement(accounts, allocation, cashBalances, column), generatedAt: now };
}

// ---------- Downloads (Log Aktivitas, like Neraca saldo) ----------

export type StatementReport = BalanceSheetReport | IncomeStatementReport | CashFlowReport;
export type StatementFormat = "pdf" | "xlsx";

/** Audited once the file exists: the report, its period and format, never a figure. */
export async function recordStatementDownload(actorStaffUserId: string, report: StatementReport, format: StatementFormat, db: Database = defaultDb): Promise<void> {
  const balanced = report.statement.checks.every((check) => check.ok);
  switch (report.kind) {
    case "balance_sheet":
      await writeAuditLog(db, {
        actorStaffUserId,
        action: "download",
        entityType: "balance_sheet",
        entityId: report.asOf,
        after: { format, asOf: report.asOf, comparison: report.comparison.kind, balanced },
      });
      return;
    case "income_statement":
      await writeAuditLog(db, {
        actorStaffUserId,
        action: "download",
        entityType: "income_statement",
        entityId: `${report.range.from}_${report.range.to}`,
        after: { format, from: report.range.from, to: report.range.to, view: report.view, balanced },
      });
      return;
    case "cash_flow":
      await writeAuditLog(db, {
        actorStaffUserId,
        action: "download",
        entityType: "cash_flow_statement",
        entityId: `${report.range.from}_${report.range.to}`,
        after: { format, from: report.range.from, to: report.range.to, balanced },
      });
      return;
  }
}
