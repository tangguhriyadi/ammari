import "server-only";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { db as defaultDb } from "@ammari/db";
import {
  accountMappings,
  accounts,
  businessExpenses,
  expenseCategories,
  expenseItems,
  fiscalPeriods,
  journalEntries,
  journalLines,
  postingIssues,
  postingRuns,
  productionBatches,
  purchases,
  supplierPayments,
  type PostingRunTrigger,
} from "@ammari/db/schema";
import { POSTING_START_DATE, postingDateFor } from "./dates";
import type { JournalLineDraft } from "./journal";
import { decideAction, planEvent, type PlannedOutcome } from "./plan";
import { expenseRule, type ExpenseSnapshot } from "./rules/expenses";
import { supplierPaymentRule, type SupplierPaymentSnapshot } from "./rules/supplier-payments";
import type { AccountInfo, PostingContext, PostingEvent, PostingKey, PostingRule } from "./rules/types";

// The posting runner (docs/plans/accounting.md §2, Session 2). Reads source records, asks each
// rule what the ledger should hold, and per posting key does one of: nothing (identical active
// journal) | insert | reverse + insert (source, mapping or rule version changed) | reverse (the
// source no longer produces a journal) | a posting issue. Running it twice changes nothing.
//
// Concurrency: each write happens in its own READ COMMITTED transaction (the 0049 period-lock
// trigger refuses any other level) under a per-key advisory lock, re-reading the active journal
// inside the lock; the partial unique index journal_entries_active_source_key is the backstop. So
// two concurrent runs never post the same key twice (Session 12 adds a run-level lock for the cron).
//
// Never called from an existing write path (the ledger is derived, plan §2): only the "Posting
// sekarang" button today, and the cron route in Session 12.

type Tx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];
export type Database = typeof defaultDb | Tx;

/** A rule plus the loader for its snapshots. */
export interface PostingSource {
  name: string;
  ruleVersion: number;
  events(db: Database, context: PostingContext): Promise<PostingEvent[]>;
}

function postingSource<S>(rule: PostingRule<S>, load: (db: Database) => Promise<S[]>): PostingSource {
  return {
    name: rule.name,
    ruleVersion: rule.ruleVersion,
    async events(db, context) {
      const snapshots = await load(db);
      return snapshots.flatMap((snapshot) => rule.events(snapshot, context));
    },
  };
}

export async function loadExpenseSnapshots(db: Database): Promise<ExpenseSnapshot[]> {
  return db
    .select({
      id: businessExpenses.id,
      expenseNo: businessExpenses.expenseNo,
      expenseDate: businessExpenses.expenseDate,
      categoryCode: businessExpenses.category,
      categoryName: sql<string>`${expenseCategories.name}::text`,
      itemId: businessExpenses.itemId,
      itemName: sql<string | null>`${expenseItems.name}::text`,
      amount: businessExpenses.amount,
      method: businessExpenses.method,
      channelId: businessExpenses.channelId,
      voidedAt: businessExpenses.voidedAt,
    })
    .from(businessExpenses)
    .innerJoin(expenseCategories, eq(expenseCategories.code, businessExpenses.category))
    .leftJoin(expenseItems, eq(expenseItems.id, businessExpenses.itemId))
    .orderBy(asc(businessExpenses.expenseDate), asc(businessExpenses.createdAt));
}

export async function loadSupplierPaymentSnapshots(db: Database): Promise<SupplierPaymentSnapshot[]> {
  const rows = await db
    .select({
      id: supplierPayments.id,
      paymentNo: supplierPayments.paymentNo,
      targetType: supplierPayments.targetType,
      purchaseNo: purchases.purchaseNo,
      batchNo: productionBatches.batchNo,
      supplierId: supplierPayments.supplierId,
      supplierName: supplierPayments.supplierName,
      paidAt: supplierPayments.paidAt,
      amount: supplierPayments.amount,
      method: supplierPayments.method,
      voidedAt: supplierPayments.voidedAt,
    })
    .from(supplierPayments)
    .leftJoin(purchases, eq(purchases.id, supplierPayments.purchaseId))
    .leftJoin(productionBatches, eq(productionBatches.id, supplierPayments.productionBatchId))
    .orderBy(asc(supplierPayments.paidAt), asc(supplierPayments.createdAt));
  return rows.map(({ purchaseNo, batchNo, ...row }) => {
    const documentNo = purchaseNo ?? batchNo;
    // Both FKs are enforced and exactly one target is set (supplier_payments_exactly_one_target_check).
    if (!documentNo) throw new Error(`supplier payment ${row.paymentNo} has no target document`);
    return { ...row, documentNo };
  });
}

export function expenseSource(rule: PostingRule<ExpenseSnapshot> = expenseRule): PostingSource {
  return postingSource(rule, loadExpenseSnapshots);
}

export function supplierPaymentSource(rule: PostingRule<SupplierPaymentSnapshot> = supplierPaymentRule): PostingSource {
  return postingSource(rule, loadSupplierPaymentSnapshots);
}

/** Every rule posting in this session: E1-E2, P3-P4, R4. */
export function defaultPostingSources(): PostingSource[] {
  return [expenseSource(), supplierPaymentSource()];
}

export async function loadPostingContext(db: Database, postingStartDate: string = POSTING_START_DATE): Promise<PostingContext> {
  const [mappingRows, accountRows] = await Promise.all([
    db.select({ key: accountMappings.mappingKey, code: accountMappings.accountCode }).from(accountMappings),
    db
      .select({ code: accounts.code, type: accounts.type, isActive: accounts.isActive, isHeader: accounts.isHeader, systemKey: accounts.systemKey })
      .from(accounts),
  ]);
  const accountMap = new Map<string, AccountInfo>();
  const systemAccounts = new Map<string, string>();
  for (const row of accountRows) {
    accountMap.set(row.code, { type: row.type, isActive: row.isActive, isHeader: row.isHeader });
    if (row.systemKey) systemAccounts.set(row.systemKey, row.code);
  }
  return {
    mappings: new Map(mappingRows.map((row) => [row.key, row.code])),
    systemAccounts,
    accounts: accountMap,
    postingStartDate,
  };
}

export interface PostingRunOptions {
  trigger: PostingRunTrigger;
  triggeredByStaffUserId?: string | null;
  sources?: PostingSource[];
  postingStartDate?: string;
}

export interface PostingRunResult {
  runId: string;
  insertedCount: number;
  reversedCount: number;
  unchangedCount: number;
  issueCount: number;
  /** Keys whose write failed (recorded as `posting_failed` issues, included in issueCount). */
  failedCount: number;
}

/** Unambiguous even if a source id or event ever contains a separator character. */
function keyString(key: PostingKey): string {
  return JSON.stringify([key.sourceType, key.sourceId, key.sourceEvent]);
}

function keyCondition(key: PostingKey) {
  return and(eq(journalEntries.sourceType, key.sourceType), eq(journalEntries.sourceId, key.sourceId), eq(journalEntries.sourceEvent, key.sourceEvent));
}

const MAX_DESCRIPTION_LENGTH = 500;

function truncateDescription(text: string): string {
  return text.length <= MAX_DESCRIPTION_LENGTH ? text : `${text.slice(0, MAX_DESCRIPTION_LENGTH - 3)}...`;
}

/** Runs `fn` in a READ COMMITTED transaction: a real transaction on the top-level client, a
 * savepoint inside an existing transaction (whose level the 0049 trigger checks). */
async function inReadCommitted<T>(db: Database, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (db instanceof PgTransaction) return db.transaction(fn);
  return (db as typeof defaultDb).transaction(fn, { isolationLevel: "read committed" });
}

interface ActiveEntry {
  id: string;
  entryNo: string;
  entryDate: string;
  sourceDate: string | null;
  ruleVersion: number | null;
  description: string;
  contentHash: string | null;
}

async function loadActiveEntries(db: Database): Promise<Map<string, ActiveEntry>> {
  const rows = await db
    .select({
      id: journalEntries.id,
      entryNo: journalEntries.entryNo,
      entryDate: journalEntries.entryDate,
      sourceDate: journalEntries.sourceDate,
      ruleVersion: journalEntries.ruleVersion,
      description: journalEntries.description,
      contentHash: journalEntries.contentHash,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      sourceEvent: journalEntries.sourceEvent,
    })
    .from(journalEntries)
    .where(and(eq(journalEntries.kind, "system"), isNull(journalEntries.reversedByEntryId)));
  const map = new Map<string, ActiveEntry>();
  for (const { sourceType, sourceId, sourceEvent, ...entry } of rows) {
    if (sourceType && sourceId && sourceEvent) map.set(keyString({ sourceType, sourceId, sourceEvent }), entry);
  }
  return map;
}

async function loadActiveEntry(tx: Database, key: PostingKey): Promise<ActiveEntry | undefined> {
  const [row] = await tx
    .select({
      id: journalEntries.id,
      entryNo: journalEntries.entryNo,
      entryDate: journalEntries.entryDate,
      sourceDate: journalEntries.sourceDate,
      ruleVersion: journalEntries.ruleVersion,
      description: journalEntries.description,
      contentHash: journalEntries.contentHash,
    })
    .from(journalEntries)
    // Same filter as loadActiveEntries: only the engine's own journals are ever re-derived.
    .where(and(keyCondition(key), eq(journalEntries.kind, "system"), isNull(journalEntries.reversedByEntryId)));
  return row;
}

async function loadClosedMonths(tx: Tx): Promise<Set<string>> {
  const rows = await tx.select({ month: fiscalPeriods.month }).from(fiscalPeriods).where(eq(fiscalPeriods.status, "closed"));
  return new Set(rows.map((row) => row.month));
}

/** JU-YYYYMM-NNNN for the month of `entryDate`, under a per-month advisory lock (same idiom as
 * apps/admin lib/documents/document-number.ts); the unique constraint is the backstop. */
async function nextEntryNo(tx: Tx, entryDate: string): Promise<string> {
  const monthPrefix = `JU-${entryDate.slice(0, 4)}${entryDate.slice(5, 7)}-`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${monthPrefix}))`);
  const [row] = await tx
    .select({ maxSeq: sql<number | null>`max(split_part(${journalEntries.entryNo}, '-', 3)::int)` })
    .from(journalEntries)
    .where(sql`${journalEntries.entryNo} like ${`${monthPrefix}%`}`);
  return `${monthPrefix}${String((row?.maxSeq ?? 0) + 1).padStart(4, "0")}`;
}

async function insertLines(tx: Tx, entryId: string, lines: readonly JournalLineDraft[]): Promise<void> {
  await tx.insert(journalLines).values(
    lines.map((line, index) => ({
      entryId,
      lineNo: index + 1,
      accountCode: line.accountCode,
      debit: line.debit,
      credit: line.credit,
      memo: line.memo ?? null,
      channelId: line.channelId ?? null,
      supplierId: line.supplierId ?? null,
      orderId: line.orderId ?? null,
      cashAccountCode: line.cashAccountCode ?? null,
    })),
  );
}

/** Reverses `active` with a mirrored reversal entry, dated on the original's date or, when that
 * month is closed, the first day of the first open month after it (D-23). */
async function reverseEntry(tx: Tx, key: PostingKey, active: ActiveEntry, closedMonths: ReadonlySet<string>): Promise<void> {
  const lines = await tx
    .select({
      accountCode: journalLines.accountCode,
      debit: journalLines.debit,
      credit: journalLines.credit,
      memo: journalLines.memo,
      channelId: journalLines.channelId,
      supplierId: journalLines.supplierId,
      orderId: journalLines.orderId,
      cashAccountCode: journalLines.cashAccountCode,
    })
    .from(journalLines)
    .where(eq(journalLines.entryId, active.id))
    .orderBy(asc(journalLines.lineNo));
  const entryDate = postingDateFor(active.entryDate, closedMonths);
  const [reversal] = await tx
    .insert(journalEntries)
    .values({
      entryNo: await nextEntryNo(tx, entryDate),
      entryDate,
      sourceDate: active.sourceDate,
      sourceType: key.sourceType,
      sourceId: key.sourceId,
      sourceEvent: key.sourceEvent,
      ruleVersion: active.ruleVersion,
      kind: "reversal",
      reversesEntryId: active.id,
      description: truncateDescription(`Pembalik ${active.entryNo}: ${active.description}`),
    })
    .returning({ id: journalEntries.id });
  if (!reversal) throw new Error(`failed to insert the reversal of ${active.entryNo}`);
  await insertLines(
    tx,
    reversal.id,
    lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
  );
  await tx.update(journalEntries).set({ reversedByEntryId: reversal.id }).where(eq(journalEntries.id, active.id));
}

async function insertEntry(tx: Tx, planned: Extract<PlannedOutcome, { kind: "journal" }>, closedMonths: ReadonlySet<string>): Promise<void> {
  const entryDate = postingDateFor(planned.sourceDate, closedMonths);
  const [entry] = await tx
    .insert(journalEntries)
    .values({
      entryNo: await nextEntryNo(tx, entryDate),
      entryDate,
      sourceDate: planned.sourceDate,
      sourceType: planned.key.sourceType,
      sourceId: planned.key.sourceId,
      sourceEvent: planned.key.sourceEvent,
      ruleVersion: planned.ruleVersion,
      kind: "system",
      description: truncateDescription(planned.description),
      contentHash: planned.contentHash,
    })
    .returning({ id: journalEntries.id });
  if (!entry) throw new Error(`failed to insert the journal for ${keyString(planned.key)}`);
  await insertLines(tx, entry.id, planned.lines);
}

type WriteResult = { inserted: number; reversed: number; unchanged: number };

/** The write half for one key, under its advisory lock, re-deciding against the active journal as
 * it is now (another run may have posted it since the pre-read). */
async function applyPlanned(db: Database, planned: PlannedOutcome, requiresActiveJournalFor: PostingKey | undefined): Promise<WriteResult> {
  return inReadCommitted(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ammari.posting'), hashtext(${keyString(planned.key)}))`);
    // Re-checked inside the transaction: the original's own reverse + repost is atomic, so a
    // committed original always has exactly one active journal.
    if (requiresActiveJournalFor && !(await loadActiveEntry(tx, requiresActiveJournalFor))) return { inserted: 0, reversed: 0, unchanged: 0 };
    const active = await loadActiveEntry(tx, planned.key);
    const action = decideAction(planned, active ? active.contentHash : undefined);
    if (action === "unchanged" || action === "skip" || action === "issue") return { inserted: 0, reversed: 0, unchanged: action === "unchanged" ? 1 : 0 };
    const closedMonths = await loadClosedMonths(tx);
    let reversed = 0;
    if ((action === "reverse" || action === "reverse_and_insert") && active) {
      await reverseEntry(tx, planned.key, active, closedMonths);
      reversed = 1;
    }
    let inserted = 0;
    if ((action === "insert" || action === "reverse_and_insert") && planned.kind === "journal") {
      await insertEntry(tx, planned, closedMonths);
      inserted = 1;
    }
    return { inserted, reversed, unchanged: 0 };
  });
}

interface OpenIssue {
  issueCode: string;
}

async function loadOpenIssues(db: Database): Promise<Map<string, OpenIssue[]>> {
  const rows = await db
    .select({ sourceType: postingIssues.sourceType, sourceId: postingIssues.sourceId, sourceEvent: postingIssues.sourceEvent, issueCode: postingIssues.issueCode })
    .from(postingIssues)
    .where(isNull(postingIssues.resolvedAt));
  const map = new Map<string, OpenIssue[]>();
  for (const row of rows) {
    const keyText = keyString(row);
    map.set(keyText, [...(map.get(keyText) ?? []), { issueCode: row.issueCode }]);
  }
  return map;
}

async function recordIssue(db: Database, runId: string, key: PostingKey, sourceDate: string | null, issueCode: string, details: Record<string, unknown>): Promise<void> {
  await db
    .insert(postingIssues)
    .values({ ...key, sourceDate, issueCode, details, lastRunId: runId })
    .onConflictDoUpdate({
      target: [postingIssues.sourceType, postingIssues.sourceId, postingIssues.sourceEvent, postingIssues.issueCode],
      targetWhere: isNull(postingIssues.resolvedAt),
      // greatest(): a concurrent run's insert of the same issue may carry a later first_seen_at
      // than this statement's now() (posting_issues_seen_check).
      set: { details, sourceDate, lastSeenAt: sql`greatest(now(), ${postingIssues.firstSeenAt})`, lastRunId: runId },
    });
}

/** Closes this key's open issues, except `keepCode` (the one this run raised again). */
async function resolveIssues(db: Database, key: PostingKey, keepCode: string | null): Promise<void> {
  await db
    .update(postingIssues)
    .set({ resolvedAt: sql`greatest(now(), ${postingIssues.firstSeenAt})` })
    .where(
      and(
        eq(postingIssues.sourceType, key.sourceType),
        eq(postingIssues.sourceId, key.sourceId),
        eq(postingIssues.sourceEvent, key.sourceEvent),
        isNull(postingIssues.resolvedAt),
        keepCode === null ? undefined : ne(postingIssues.issueCode, keepCode),
      ),
    );
}

/** The database's own message (drizzle wraps it as `cause` under a "Failed query: ..." text that
 * holds only the SQL and parameters). */
function errorMessage(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
  const message = cause?.message ?? (error instanceof Error ? error.message : String(error));
  return message.slice(0, 500);
}

/** One posting run over every source (plan §2). Records itself in posting_runs. A key that fails
 * to write becomes a `posting_failed` issue and the run goes on; a failure outside any key (e.g.
 * loading a source) marks the run failed and is re-thrown. */
export async function runPosting(db: Database, options: PostingRunOptions): Promise<PostingRunResult> {
  const sources = options.sources ?? defaultPostingSources();
  const [run] = await db
    .insert(postingRuns)
    .values({ trigger: options.trigger, triggeredByStaffUserId: options.triggeredByStaffUserId ?? null })
    .returning({ id: postingRuns.id });
  if (!run) throw new Error("failed to start a posting run");
  const result: PostingRunResult = { runId: run.id, insertedCount: 0, reversedCount: 0, unchangedCount: 0, issueCount: 0, failedCount: 0 };

  try {
    const context = await loadPostingContext(db, options.postingStartDate);
    const [activeEntries, openIssues] = await Promise.all([loadActiveEntries(db), loadOpenIssues(db)]);

    for (const source of sources) {
      const events = await source.events(db, context);
      for (const event of events) {
        const keyText = keyString(event.key);
        const keyIssues = openIssues.get(keyText) ?? [];

        // A void whose original has no active journal (dated before the cut-over, or still held by
        // an issue) does nothing: no journal, no issue (plan §2). Checked against the database, not
        // the pre-read, because the original may have been posted earlier in this same run.
        if (event.requiresActiveJournalFor && !(await loadActiveEntry(db, event.requiresActiveJournalFor))) {
          if (keyIssues.length > 0) await resolveIssues(db, event.key, null);
          continue;
        }

        const planned = planEvent(event, source.ruleVersion, context);

        if (planned.kind === "issue") {
          result.issueCount += 1;
          await recordIssue(db, run.id, planned.key, planned.sourceDate, planned.issueCode, planned.details);
          if (keyIssues.some((issue) => issue.issueCode !== planned.issueCode)) await resolveIssues(db, planned.key, planned.issueCode);
          continue;
        }

        // Pre-read: most keys are unchanged, and those need no transaction or lock at all.
        const active = activeEntries.get(keyText);
        const preAction = decideAction(planned, active ? active.contentHash : undefined);
        try {
          if (preAction === "unchanged") {
            result.unchangedCount += 1;
          } else if (preAction !== "skip") {
            const written = await applyPlanned(db, planned, event.requiresActiveJournalFor);
            result.insertedCount += written.inserted;
            result.reversedCount += written.reversed;
            result.unchangedCount += written.unchanged;
          }
        } catch (error) {
          result.failedCount += 1;
          result.issueCount += 1;
          console.error(`[accounting] posting ${keyText} failed`, error);
          await recordIssue(db, run.id, planned.key, planned.sourceDate, "posting_failed", { message: errorMessage(error) });
          continue;
        }
        if (keyIssues.length > 0) await resolveIssues(db, planned.key, null);
      }
    }
  } catch (error) {
    await db
      .update(postingRuns)
      .set({ status: "failed", finishedAt: sql`greatest(clock_timestamp(), ${postingRuns.startedAt})`, error: errorMessage(error) || "unknown error", ...counts(result) })
      .where(eq(postingRuns.id, run.id));
    throw error;
  }

  await db
    .update(postingRuns)
    .set({ status: "succeeded", finishedAt: sql`greatest(clock_timestamp(), ${postingRuns.startedAt})`, ...counts(result) })
    .where(eq(postingRuns.id, run.id));
  return result;
}

function counts(result: PostingRunResult) {
  return {
    insertedCount: result.insertedCount,
    reversedCount: result.reversedCount,
    unchangedCount: result.unchangedCount,
    issueCount: result.issueCount,
  };
}
