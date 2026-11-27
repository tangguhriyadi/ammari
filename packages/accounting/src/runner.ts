import "server-only";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  accountMappings,
  accounts,
  businessExpenses,
  expenseCategories,
  expenseItems,
  journalEntries,
  postingIssues,
  postingRuns,
  productionBatches,
  purchases,
  supplierPayments,
  type PostingRunTrigger,
} from "@ammari/db/schema";
import { crossesCutover } from "./books";
import { inReadCommitted, insertLines, insertReversal, loadClosedMonths, nextEntryNo, truncateDescription, type Database, type Tx } from "./ledger-write";
import { POSTING_START_DATE, postingDateFor } from "./dates";
import { comparableActiveHash, decideAction, planEvent, type PlannedOutcome } from "./plan";
import { expenseRule, type ExpenseSnapshot } from "./rules/expenses";
import { supplierPaymentRule, type SupplierPaymentSnapshot } from "./rules/supplier-payments";
import { purchaseChainRule, type PurchaseDocumentSnapshot } from "./rules/purchases";
import { rawMaterialAdjustmentRule, type RawMaterialMovementSnapshot } from "./rules/raw-materials";
import { loadPurchaseDocumentSnapshots, loadRawMaterialMovementSnapshots } from "./purchase-loaders";
import { productionChainRule, type ProductionBatchSnapshot } from "./rules/production";
import { defectDisposalRule, finishedGoodsAdjustmentRule, type DefectDisposalSnapshot, type FinishedGoodsAdjustmentSnapshot } from "./rules/inventory";
import { salesRule, type OrderSnapshot } from "./rules/sales";
import { loadOrderSnapshots } from "./sales-loaders";
import { loadDefectDisposalSnapshots, loadFinishedGoodsAdjustmentSnapshots, loadProductionBatchSnapshots } from "./production-loaders";
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

export type { Database } from "./ledger-write";
export { loadProductionBatchSnapshots } from "./production-loaders";
export { loadOrderSnapshots } from "./sales-loaders";

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

/** P1, P2, P3/P4 (with the document chain), P5, P6 (Session 7). */
export function purchaseChainSource(rule: PostingRule<PurchaseDocumentSnapshot> = purchaseChainRule): PostingSource {
  return postingSource(rule, loadPurchaseDocumentSnapshots);
}

/** P7 (Session 7). */
export function rawMaterialAdjustmentSource(rule: PostingRule<RawMaterialMovementSnapshot> = rawMaterialAdjustmentRule): PostingSource {
  return postingSource(rule, loadRawMaterialMovementSnapshots);
}

/** R1-R5 with the batch payments on the position rule (Session 8). */
export function productionChainSource(rule: PostingRule<ProductionBatchSnapshot> = productionChainRule): PostingSource {
  return postingSource(rule, loadProductionBatchSnapshots);
}

/** A1 (Session 8). */
export function finishedGoodsAdjustmentSource(rule: PostingRule<FinishedGoodsAdjustmentSnapshot> = finishedGoodsAdjustmentRule): PostingSource {
  return postingSource(rule, loadFinishedGoodsAdjustmentSnapshots);
}

/** A2 (Session 8). */
export function defectDisposalSource(rule: PostingRule<DefectDisposalSnapshot> = defectDisposalRule): PostingSource {
  return postingSource(rule, loadDefectDisposalSnapshots);
}

/** S1-S6, W1, W3, W4, W9, W10, M1, M2 (Session 9). */
export function salesSource(rule: PostingRule<OrderSnapshot> = salesRule): PostingSource {
  return postingSource(rule, loadOrderSnapshots);
}

/** Every rule posting so far: E1-E2 (expenses), the purchase chain P1-P6, P7, the production chain
 * R1-R5 (batch payments included, Session 8), A1 and A2, and the sales chain (Session 9: S1-S6,
 * W1, W3, W4, W9, W10, M1, M2; W2/W5 wait for fee work A+B, Session 11). Each posting key is emitted by exactly one
 * source. The production chain runs after the purchase chain, so a batch's consumption (R1) is
 * booked after the receipts that brought the material in, within the same run. The supplier_payment
 * rule (Session 2) emits nothing any more and is not listed. */
export function defaultPostingSources(): PostingSource[] {
  return [expenseSource(), purchaseChainSource(), rawMaterialAdjustmentSource(), productionChainSource(), finishedGoodsAdjustmentSource(), defectDisposalSource(), salesSource()];
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

/** A void (an event that only negates its original) is posted only while the original has an
 * active journal (plan §2) AND both sit in the same set of books (books.ts, Session 4): a December
 * trial-month original voided in 2027 posts nothing, since the opening journal already reflects
 * the correction. */
async function originalAllowsVoid(db: Database, original: PostingKey, voidDate: string, acrossBooks = false): Promise<boolean> {
  const active = await loadActiveEntry(db, original);
  if (!active) return false;
  // A real event held behind a blocked original (requiresActiveJournalAcrossBooks) is not a negation:
  // once the original posts it follows, whichever set of books the original is in.
  return acrossBooks || !crossesCutover(active.sourceDate ?? active.entryDate, voidDate);
}

type Dependency = Pick<PostingEvent, "requiresActiveJournalFor" | "requiresActiveJournalAcrossBooks">;

async function dependencyAllows(db: Database, event: Dependency, sourceDate: string): Promise<boolean> {
  if (!event.requiresActiveJournalFor) return true;
  return originalAllowsVoid(db, event.requiresActiveJournalFor, sourceDate, event.requiresActiveJournalAcrossBooks === true);
}

/** Reverses `active` with a mirrored reversal entry, dated on the original's date or, when that
 * month is closed, the first day of the first open month after it (D-23). */
async function reverseEntry(tx: Tx, key: PostingKey, active: ActiveEntry): Promise<void> {
  await insertReversal(tx, { ...active, ...key }, `Pembalik ${active.entryNo}: ${active.description}`, null);
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
async function applyPlanned(db: Database, planned: PlannedOutcome, dependency: Dependency): Promise<WriteResult> {
  return inReadCommitted(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ammari.posting'), hashtext(${keyString(planned.key)}))`);
    // Re-checked inside the transaction: the original's own reverse + repost is atomic, so a
    // committed original always has exactly one active journal.
    if (!(await dependencyAllows(tx, dependency, planned.sourceDate))) return { inserted: 0, reversed: 0, unchanged: 0 };
    const active = await loadActiveEntry(tx, planned.key);
    const action = decideAction(planned, comparableActiveHash(planned, active));
    if (action === "unchanged" || action === "skip" || action === "issue") return { inserted: 0, reversed: 0, unchanged: action === "unchanged" ? 1 : 0 };
    const closedMonths = await loadClosedMonths(tx);
    let reversed = 0;
    if ((action === "reverse" || action === "reverse_and_insert") && active) {
      await reverseEntry(tx, planned.key, active);
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
        if (event.requiresActiveJournalFor && !(await dependencyAllows(db, event, event.sourceDate))) {
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
        const preAction = decideAction(planned, comparableActiveHash(planned, active));
        try {
          if (preAction === "unchanged") {
            result.unchangedCount += 1;
          } else if (preAction !== "skip") {
            const written = await applyPlanned(db, planned, event);
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

// ---------- Rekonsiliasi check 5: posting completeness (plan §6.3, Session 10) ----------

/** Why a source event is not (correctly) in the ledger although no open issue explains it. */
export type PostingGapStatus =
  /** The rule says "post this journal" and there is no active journal for the key. */
  | "missing"
  /** An active journal exists but differs from what the rule says now (source, mapping or rule changed). */
  | "outdated"
  /** The rule posts nothing any more but a journal is still active. */
  | "stale"
  /** The rule raises an issue that is not in the open-issue queue yet. */
  | "issue_unrecorded";

export interface PostingGap {
  key: PostingKey;
  sourceDate: string;
  status: PostingGapStatus;
  issueCode?: string;
}

export interface PostingCompleteness {
  /** Source events dated in the window the rules produce a journal or an issue for. */
  checkedEvents: number;
  /** ... of which the identical journal is active. */
  posted: number;
  /** ... of which an open posting issue explains the missing journal. */
  withOpenIssue: number;
  /** Events held behind their original (a void, a held return), which posts nothing yet. */
  held: number;
  gaps: PostingGap[];
  /** Active system journals in the window whose key no rule produces any more (e.g. a source
   * that vanished): the next run does not touch them, so they need a look. Only meaningful with the
   * full default source list (a subset reports every other source's journals here). */
  orphans: { key: PostingKey; entryNo: string; entryDate: string }[];
}

/**
 * Read-only dry run of the posting runner over every source (plan §6.3 check 5: "every source event
 * after the cut-over has an active journal or an open issue"). Writes nothing: it compares what each
 * rule would post for events dated in [from, to] with the active journals and the open issues as
 * they are now. A gap means "Posting sekarang" has not run since the source changed (or a write
 * failed without an issue); after a successful run every gap is gone.
 */
export async function checkPostingCompleteness(
  db: Database,
  window: { from: string; to: string },
  options: { sources?: PostingSource[]; postingStartDate?: string } = {},
): Promise<PostingCompleteness> {
  const sources = options.sources ?? defaultPostingSources();
  const context = await loadPostingContext(db, options.postingStartDate);
  const [activeEntries, openIssues] = await Promise.all([loadActiveEntries(db), loadOpenIssues(db)]);
  const result: PostingCompleteness = { checkedEvents: 0, posted: 0, withOpenIssue: 0, held: 0, gaps: [], orphans: [] };
  const emitted = new Set<string>();
  const inWindow = (date: string) => date >= window.from && date <= window.to;

  for (const source of sources) {
    for (const event of await source.events(db, context)) {
      const keyText = keyString(event.key);
      emitted.add(keyText);
      if (!inWindow(event.sourceDate)) continue;
      if (event.requiresActiveJournalFor) {
        // Same rule as dependencyAllows, against the pre-read (nothing is written here).
        const original = activeEntries.get(keyString(event.requiresActiveJournalFor));
        const allowed = !!original && (event.requiresActiveJournalAcrossBooks === true || !crossesCutover(original.sourceDate ?? original.entryDate, event.sourceDate));
        if (!allowed) {
          if (event.outcome.kind !== "none") result.held += 1;
          continue;
        }
      }
      const planned = planEvent(event, source.ruleVersion, context);
      const active = activeEntries.get(keyText);
      const issues = openIssues.get(keyText) ?? [];
      if (planned.kind === "none") {
        if (active) result.gaps.push({ key: planned.key, sourceDate: planned.sourceDate, status: "stale" });
        continue;
      }
      result.checkedEvents += 1;
      if (planned.kind === "issue") {
        if (issues.some((issue) => issue.issueCode === planned.issueCode)) result.withOpenIssue += 1;
        else result.gaps.push({ key: planned.key, sourceDate: planned.sourceDate, status: "issue_unrecorded", issueCode: planned.issueCode });
        continue;
      }
      const action = decideAction(planned, comparableActiveHash(planned, active));
      if (action === "unchanged") result.posted += 1;
      // A failed write leaves a posting_failed issue: explained, not a silent gap. Any other open
      // issue on the key is stale (e.g. a mapping fixed since): the next run resolves it, so it is a gap.
      else if (issues.some((issue) => issue.issueCode === "posting_failed")) result.withOpenIssue += 1;
      else result.gaps.push({ key: planned.key, sourceDate: planned.sourceDate, status: action === "insert" ? "missing" : "outdated" });
    }
  }

  for (const [keyText, entry] of activeEntries) {
    if (emitted.has(keyText)) continue;
    const date = entry.sourceDate ?? entry.entryDate;
    if (!inWindow(date)) continue;
    const [sourceType, sourceId, sourceEvent] = JSON.parse(keyText) as [string, string, string];
    result.orphans.push({ key: { sourceType, sourceId, sourceEvent }, entryNo: entry.entryNo, entryDate: entry.entryDate });
  }
  result.gaps.sort((a, b) => a.sourceDate.localeCompare(b.sourceDate) || keyString(a.key).localeCompare(keyString(b.key)));
  result.orphans.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.entryNo.localeCompare(b.entryNo));
  return result;
}
