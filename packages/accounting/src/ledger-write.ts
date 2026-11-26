import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { db as defaultDb } from "@ammari/db";
import { fiscalPeriods, journalEntries, journalLines } from "@ammari/db/schema";
import { postingDateFor } from "./dates";
import type { JournalLineDraft } from "./journal";

// The low-level journal writes shared by the posting runner (runner.ts) and the manual, opening
// and reversal journals the admin writes (Session 4). Every write runs at READ COMMITTED: the 0049
// period-lock trigger refuses any other level, since its closed-month read must see a close that
// committed while the write waited for the month's lock.

export type Tx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];
export type Database = typeof defaultDb | Tx;

/** Runs `fn` in a READ COMMITTED transaction: a real transaction on the top-level client, a
 * savepoint inside an existing transaction (whose level the 0049 trigger checks). */
export async function inReadCommitted<T>(db: Database, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (db instanceof PgTransaction) return db.transaction(fn);
  return (db as typeof defaultDb).transaction(fn, { isolationLevel: "read committed" });
}

/** JU-YYYYMM-NNNN for the month of `entryDate`, under a per-month advisory lock (same idiom as
 * apps/admin lib/documents/document-number.ts); the unique constraint is the backstop. */
export async function nextEntryNo(tx: Tx, entryDate: string): Promise<string> {
  const monthPrefix = `JU-${entryDate.slice(0, 4)}${entryDate.slice(5, 7)}-`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${monthPrefix}))`);
  const [row] = await tx
    .select({ maxSeq: sql<number | null>`max(split_part(${journalEntries.entryNo}, '-', 3)::int)` })
    .from(journalEntries)
    .where(sql`${journalEntries.entryNo} like ${`${monthPrefix}%`}`);
  return `${monthPrefix}${String((row?.maxSeq ?? 0) + 1).padStart(4, "0")}`;
}

export async function insertLines(tx: Tx, entryId: string, lines: readonly JournalLineDraft[]): Promise<void> {
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

/** First-of-month dates of the closed periods (no row = open). Read without the month locks: the
 * insert trigger takes the month's shared lock and re-checks, so a close that slips in between
 * makes the insert fail loudly instead of writing into a closed month. */
export async function loadClosedMonths(tx: Database): Promise<Set<string>> {
  const rows = await tx.select({ month: fiscalPeriods.month }).from(fiscalPeriods).where(eq(fiscalPeriods.status, "closed"));
  return new Set(rows.map((row) => row.month));
}

const MAX_DESCRIPTION_LENGTH = 500;

export function truncateDescription(text: string): string {
  return text.length <= MAX_DESCRIPTION_LENGTH ? text : `${text.slice(0, MAX_DESCRIPTION_LENGTH - 3)}...`;
}

export interface ReversalResult {
  id: string;
  entryNo: string;
  entryDate: string;
}

/** Inserts the mirrored reversal of entry `target` (every line, debit and credit swapped, same
 * dimensions) and stamps the target, in `tx`. Dated on the target's date, or the first day of the
 * first open month after it when that month is closed (D-23). The caller has locked the target
 * row and checked it may be reversed; the 0049 triggers re-check the mirror and the stamp. */
export async function insertReversal(
  tx: Tx,
  target: { id: string; entryNo: string; entryDate: string; sourceDate: string | null; sourceType: string | null; sourceId: string | null; sourceEvent: string | null; ruleVersion: number | null },
  description: string,
  postedByStaffUserId: string | null,
): Promise<ReversalResult> {
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
    .where(eq(journalLines.entryId, target.id))
    .orderBy(asc(journalLines.lineNo));
  const entryDate = postingDateFor(target.entryDate, await loadClosedMonths(tx));
  const entryNo = await nextEntryNo(tx, entryDate);
  const [reversal] = await tx
    .insert(journalEntries)
    .values({
      entryNo,
      entryDate,
      sourceDate: target.sourceDate,
      sourceType: target.sourceType,
      sourceId: target.sourceId,
      sourceEvent: target.sourceEvent,
      ruleVersion: target.ruleVersion,
      kind: "reversal",
      reversesEntryId: target.id,
      postedByStaffUserId,
      description: truncateDescription(description),
    })
    .returning({ id: journalEntries.id });
  if (!reversal) throw new Error(`failed to insert the reversal of ${target.entryNo}`);
  await insertLines(
    tx,
    reversal.id,
    lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
  );
  await tx.update(journalEntries).set({ reversedByEntryId: reversal.id }).where(eq(journalEntries.id, target.id));
  return { id: reversal.id, entryNo, entryDate };
}
