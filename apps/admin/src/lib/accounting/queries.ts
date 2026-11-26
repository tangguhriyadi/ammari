import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  accounts,
  businessExpenses,
  channels,
  journalEntries,
  journalLines,
  postingIssues,
  postingRuns,
  staffUsers,
  supplierPayments,
  suppliers,
  type AccountNormalBalance,
  type ChannelId,
  type JournalEntryKind,
} from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";
import { resolveReportRange, bookSegmentOf, type ReportRange } from "@ammari/accounting";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { defaultDb, type Database } from "@/lib/db";
import type { JournalFilters, LedgerFilters } from "./filters";
import { IS_OPENING_SQL } from "./trial-balance";

// Reads for Jurnal umum and Buku besar (docs/plans/accounting.md §6, Session 2). Read-only: the
// journal tables are written by the posting runner (packages/accounting) and, since Session 4, by
// manual/opening journals and their reversals (manual-journals.ts, opening-balance.ts). Balances are
// summed within one set of books (books.ts): the December 2026 trial month or the official books
// from 1 Jan 2027, whose opening journal counts as the opening balance.

export interface SourceRef {
  label: string;
  href: string | null;
}

export interface JournalLineRow {
  lineNo: number;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  memo: string | null;
}

export interface JournalEntryRow {
  id: string;
  entryNo: string;
  entryDate: string;
  sourceDate: string | null;
  kind: JournalEntryKind;
  description: string;
  sourceType: string | null;
  sourceEvent: string | null;
  source: SourceRef | null;
  reversesEntryNo: string | null;
  reversedByEntryNo: string | null;
  lines: JournalLineRow[];
  debitTotal: number;
  /** Dated in the December 2026 trial month (D-22): practice books, not the official ones. */
  isTrial: boolean;
  /** A manual or opening journal not yet reversed: staff may reverse it (plan §7). */
  canReverse: boolean;
  attachmentFileId: string | null;
  postedByName: string | null;
}

/** The document a journal came from, with a link to its page when one exists. */
function sourceRef(row: {
  sourceType: string | null;
  expenseNo: string | null;
  paymentNo: string | null;
  purchaseId: string | null;
  productionBatchId: string | null;
}): SourceRef | null {
  if (row.sourceType === "business_expense" && row.expenseNo) return { label: row.expenseNo, href: null };
  if (row.sourceType === "supplier_payment" && row.paymentNo) {
    if (row.purchaseId) return { label: row.paymentNo, href: `/purchases/${row.purchaseId}` };
    if (row.productionBatchId) return { label: row.paymentNo, href: `/production/${row.productionBatchId}` };
    return { label: row.paymentNo, href: null };
  }
  return null;
}

function journalWhere(filters: JournalFilters): SQL | undefined {
  const conditions: (SQL | undefined)[] = [gte(journalEntries.entryDate, filters.from), lte(journalEntries.entryDate, filters.to)];
  if (filters.sourceType) conditions.push(eq(journalEntries.sourceType, filters.sourceType));
  if (filters.kind) conditions.push(eq(journalEntries.kind, filters.kind));
  if (filters.accountCode) {
    conditions.push(
      // qualifiedColumn on both sides of the correlation: a bare ${journalEntries.id} renders
      // unqualified when the outer query has no join (packages/db/src/sql-helpers.ts).
      sql`exists (select 1 from ${journalLines} where ${qualifiedColumn(journalLines, journalLines.entryId)} = ${qualifiedColumn(journalEntries, journalEntries.id)} and ${qualifiedColumn(journalLines, journalLines.accountCode)} = ${filters.accountCode})`,
    );
  }
  return and(...conditions);
}

export async function listJournalEntries(
  filters: JournalFilters,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: JournalEntryRow[]; pagination: Pagination }> {
  const where = journalWhere(filters);
  const [countRow] = await db.select({ totalCount: sql<number>`count(*)::int` }).from(journalEntries).where(where);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: countRow?.totalCount ?? 0 });

  const reverses = alias(journalEntries, "reverses");
  const reversedBy = alias(journalEntries, "reversed_by");
  const entries = await db
    .select({
      id: journalEntries.id,
      entryNo: journalEntries.entryNo,
      entryDate: journalEntries.entryDate,
      sourceDate: journalEntries.sourceDate,
      kind: journalEntries.kind,
      description: journalEntries.description,
      sourceType: journalEntries.sourceType,
      sourceEvent: journalEntries.sourceEvent,
      reversesEntryNo: reverses.entryNo,
      reversedByEntryNo: reversedBy.entryNo,
      attachmentFileId: journalEntries.attachmentFileId,
      postedByName: staffUsers.name,
      expenseNo: businessExpenses.expenseNo,
      paymentNo: supplierPayments.paymentNo,
      purchaseId: supplierPayments.purchaseId,
      productionBatchId: supplierPayments.productionBatchId,
    })
    .from(journalEntries)
    .leftJoin(reverses, eq(reverses.id, journalEntries.reversesEntryId))
    .leftJoin(reversedBy, eq(reversedBy.id, journalEntries.reversedByEntryId))
    .leftJoin(staffUsers, eq(staffUsers.id, journalEntries.postedByStaffUserId))
    .leftJoin(businessExpenses, and(eq(journalEntries.sourceType, "business_expense"), sql`${businessExpenses.id}::text = ${journalEntries.sourceId}`))
    .leftJoin(supplierPayments, and(eq(journalEntries.sourceType, "supplier_payment"), sql`${supplierPayments.id}::text = ${journalEntries.sourceId}`))
    .where(where)
    .orderBy(desc(journalEntries.entryDate), desc(journalEntries.entryNo))
    .limit(pagination.limit)
    .offset(pagination.offset);

  const lineRows =
    entries.length === 0
      ? []
      : await db
          .select({
            entryId: journalLines.entryId,
            lineNo: journalLines.lineNo,
            accountCode: journalLines.accountCode,
            accountName: sql<string>`${accounts.name}::text`,
            debit: journalLines.debit,
            credit: journalLines.credit,
            memo: journalLines.memo,
          })
          .from(journalLines)
          .innerJoin(accounts, eq(accounts.code, journalLines.accountCode))
          .where(inArray(journalLines.entryId, entries.map((entry) => entry.id)))
          .orderBy(asc(journalLines.entryId), asc(journalLines.lineNo));

  const linesByEntry = new Map<string, JournalLineRow[]>();
  for (const { entryId, ...line } of lineRows) linesByEntry.set(entryId, [...(linesByEntry.get(entryId) ?? []), line]);

  const rows = entries.map(({ expenseNo, paymentNo, purchaseId, productionBatchId, ...entry }) => {
    const lines = linesByEntry.get(entry.id) ?? [];
    return {
      ...entry,
      source: sourceRef({ sourceType: entry.sourceType, expenseNo, paymentNo, purchaseId, productionBatchId }),
      lines,
      debitTotal: lines.reduce((total, line) => total + line.debit, 0),
      isTrial: bookSegmentOf(entry.entryDate) === "trial",
      canReverse: (entry.kind === "manual" || entry.kind === "opening") && entry.reversedByEntryNo === null,
    };
  });
  return { rows, pagination };
}

export interface AccountOption {
  code: string;
  name: string;
  isActive: boolean;
}

/** Postable accounts (not headers), in chart order, for the account pickers. */
export async function listPostableAccounts(db: Database = defaultDb): Promise<AccountOption[]> {
  return db
    .select({ code: accounts.code, name: sql<string>`${accounts.name}::text`, isActive: accounts.isActive })
    .from(accounts)
    .where(eq(accounts.isHeader, false))
    .orderBy(asc(accounts.sortOrder), asc(accounts.code));
}

export interface PostingIssueRow {
  id: string;
  sourceType: string;
  sourceEvent: string;
  sourceDate: string | null;
  issueCode: string;
  details: Record<string, unknown>;
  lastSeenAt: Date;
  documentNo: string | null;
}

/** Open posting issues (plan §2: never silently skipped), oldest source first, with the total. */
export async function listOpenPostingIssues(limit = 20, db: Database = defaultDb): Promise<{ rows: PostingIssueRow[]; totalCount: number }> {
  const [countRow] = await db.select({ totalCount: sql<number>`count(*)::int` }).from(postingIssues).where(isNull(postingIssues.resolvedAt));
  const rows = await db
    .select({
      id: postingIssues.id,
      sourceType: postingIssues.sourceType,
      sourceEvent: postingIssues.sourceEvent,
      sourceDate: postingIssues.sourceDate,
      issueCode: postingIssues.issueCode,
      details: postingIssues.details,
      lastSeenAt: postingIssues.lastSeenAt,
      documentNo: sql<string | null>`coalesce(${businessExpenses.expenseNo}, ${supplierPayments.paymentNo})`,
    })
    .from(postingIssues)
    .leftJoin(businessExpenses, and(eq(postingIssues.sourceType, "business_expense"), sql`${businessExpenses.id}::text = ${postingIssues.sourceId}`))
    .leftJoin(supplierPayments, and(eq(postingIssues.sourceType, "supplier_payment"), sql`${supplierPayments.id}::text = ${postingIssues.sourceId}`))
    .where(isNull(postingIssues.resolvedAt))
    .orderBy(sql`${postingIssues.sourceDate} asc nulls last`, asc(postingIssues.firstSeenAt))
    .limit(limit);
  return { rows, totalCount: countRow?.totalCount ?? 0 };
}

export interface LastPostingRun {
  status: "running" | "succeeded" | "failed";
  startedAt: Date;
  finishedAt: Date | null;
}

export async function getLastPostingRun(db: Database = defaultDb): Promise<LastPostingRun | null> {
  const [row] = await db
    .select({ status: postingRuns.status, startedAt: postingRuns.startedAt, finishedAt: postingRuns.finishedAt })
    .from(postingRuns)
    .orderBy(desc(postingRuns.startedAt))
    .limit(1);
  return row ?? null;
}

// ---------- Buku besar ----------

export interface LedgerAccount {
  code: string;
  name: string;
  normalBalance: AccountNormalBalance;
}

export interface LedgerLineRow {
  entryId: string;
  entryNo: string;
  entryDate: string;
  kind: JournalEntryKind;
  description: string;
  memo: string | null;
  debit: number;
  credit: number;
  /** In the account's normal direction: debit − credit for a debit-normal account. */
  balance: number;
}

export interface Ledger {
  account: LedgerAccount;
  /** The range actually shown, kept inside one set of books (books.ts): the opening balance is
   * summed from `range.segmentStart`, so December's trial journals never reach a 2027 balance. */
  range: ReportRange;
  openingBalance: number;
  debitTotal: number;
  creditTotal: number;
  closingBalance: number;
  rows: LedgerLineRow[];
  pagination: Pagination;
}

function lineFilter(filters: LedgerFilters, accountCode: string): SQL {
  const conditions: SQL[] = [sql`l.account_code = ${accountCode}`];
  if (filters.supplierId) conditions.push(sql`l.supplier_id = ${filters.supplierId}`);
  if (filters.channelId) conditions.push(sql`l.channel_id = ${filters.channelId}`);
  return sql.join(conditions, sql` and `);
}

/** One account's ledger for a date range (plan §6), kept inside one set of books (books.ts):
 * opening balance from the segment's first day to before `from` plus the opening journal, every line in
 * the range with its running balance, and the closing balance. Optional sub-ledger filters by
 * supplier and channel. Lines are in posting order (date, journal number, line). */
export async function getLedger(filters: LedgerFilters, rawPage: string | undefined, rawPerPage: string | undefined, db: Database = defaultDb): Promise<Ledger | null> {
  if (!filters.accountCode) return null;
  const [account] = await db
    .select({ code: accounts.code, name: sql<string>`${accounts.name}::text`, normalBalance: accounts.normalBalance, isHeader: accounts.isHeader })
    .from(accounts)
    .where(eq(accounts.code, filters.accountCode));
  if (!account || account.isHeader) return null;

  // Signed in the account's normal direction.
  const signed = account.normalBalance === "debit" ? sql`(l.debit - l.credit)` : sql`(l.credit - l.debit)`;
  const where = lineFilter(filters, account.code);
  const range = resolveReportRange(filters);
  const { from, to } = range;

  const [totals] = (await db.execute(sql`
    select
      coalesce(sum(${signed}) filter (where e.entry_date < ${from} or ${IS_OPENING_SQL}), 0)::bigint as opening,
      coalesce(sum(l.debit) filter (where e.entry_date between ${from} and ${to} and not ${IS_OPENING_SQL}), 0)::bigint as debit_total,
      coalesce(sum(l.credit) filter (where e.entry_date between ${from} and ${to} and not ${IS_OPENING_SQL}), 0)::bigint as credit_total,
      (count(*) filter (where e.entry_date between ${from} and ${to} and not ${IS_OPENING_SQL}))::int as line_count
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    left join journal_entries reversed on reversed.id = e.reverses_entry_id
    where ${where} and e.entry_date >= ${range.segmentStart} and e.entry_date <= ${to}
  `)) as unknown as { opening: string; debit_total: string; credit_total: string; line_count: number }[];

  const openingBalance = Number(totals?.opening ?? 0);
  const debitTotal = Number(totals?.debit_total ?? 0);
  const creditTotal = Number(totals?.credit_total ?? 0);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totals?.line_count ?? 0 });

  const rows = (await db.execute(sql`
    select * from (
      select
        e.id as entry_id, e.entry_no, e.entry_date::text as entry_date, e.kind, e.description, l.memo,
        l.debit, l.credit,
        ${openingBalance}::bigint + sum(${signed}) over (order by e.entry_date, e.entry_no, l.line_no rows between unbounded preceding and current row) as balance,
        row_number() over (order by e.entry_date, e.entry_no, l.line_no) as position
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      left join journal_entries reversed on reversed.id = e.reverses_entry_id
      where ${where} and e.entry_date between ${from} and ${to} and not ${IS_OPENING_SQL}
    ) ledger
    where position > ${pagination.offset} and position <= ${pagination.offset + pagination.limit}
    order by position
  `)) as unknown as {
    entry_id: string;
    entry_no: string;
    entry_date: string;
    kind: JournalEntryKind;
    description: string;
    memo: string | null;
    debit: string;
    credit: string;
    balance: string;
  }[];

  return {
    account: { code: account.code, name: account.name, normalBalance: account.normalBalance },
    range,
    openingBalance,
    debitTotal,
    creditTotal,
    closingBalance: openingBalance + (account.normalBalance === "debit" ? debitTotal - creditTotal : creditTotal - debitTotal),
    rows: rows.map((row) => ({
      entryId: row.entry_id,
      entryNo: row.entry_no,
      entryDate: row.entry_date,
      kind: row.kind,
      description: row.description,
      memo: row.memo,
      debit: Number(row.debit),
      credit: Number(row.credit),
      balance: Number(row.balance),
    })),
    pagination,
  };
}

export async function listSupplierOptions(db: Database = defaultDb): Promise<{ id: string; name: string }[]> {
  return db.select({ id: suppliers.id, name: sql<string>`${suppliers.name}::text` }).from(suppliers).orderBy(asc(suppliers.name));
}

export async function listChannelOptions(db: Database = defaultDb): Promise<{ id: ChannelId; name: string }[]> {
  return db.select({ id: channels.id, name: channels.name }).from(channels).orderBy(asc(channels.name));
}
