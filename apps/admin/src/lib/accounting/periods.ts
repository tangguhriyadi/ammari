import "server-only";
import { and, asc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { inReadCommitted, loadClosedMonths } from "@ammari/accounting/ledger-write";
import { checkPostingCompleteness, defaultPostingSources, type Database as LedgerDatabase } from "@ammari/accounting/runner";
import { monthEndOf, OFFICIAL_BOOKS_START, segmentStartOf } from "@ammari/accounting";
import { fiscalPeriods, journalEntries, postingIssues, staffUsers } from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { postPeriodCloseJournals, pphFinalWarning, proposePphFinalFor } from "./period-close-postings";
import type { PphFinalProposal } from "@ammari/accounting";
import {
  closeDeadlineOf,
  MAX_PERIOD_REASON_LENGTH,
  monthLabel,
  normalizeOptionalReason,
  periodCloseRefusal,
  periodReopenRefusal,
  periodMonthsToShow,
  PERIOD_MESSAGES,
  isMonthStart,
} from "./period-rules";

// Tutup buku: closing and reopening a month (docs/plans/accounting.md §7, D-22, D-23, Session 4).
// Callers check accounting.view (reads) or accounting.view + accounting.close (writes).
//
// Closing a month: under the month's EXCLUSIVE advisory lock (the same lock every journal insert
// takes SHARED in accounting_assert_period_open, migration 0049), so an in-flight post either
// commits first and is counted, or waits and then sees the month closed. Requires no open posting
// issues for it (or a written override reason, stored on fiscal_periods.close_override_reason and
// in audit_log) and a balanced trial balance; warns, never blocks, when the PPh final rate has
// ended (D-20), and for January 2027 when no opening journal exists yet (D-22).
//
// Session 11: before setting `closed`, the close posts the month's PPh final accrual and, for
// December, the year-end closing journal (period-close-postings.ts), under the same exclusive lock.
// The MDR "still an estimate" warning (D-8) stays dormant: it reads the `source` column (added in 0061,
// shared with TikTok T7; T8 adds the TikTok estimate warning) on
// order_channel_fees (component payment_gateway_fee), which does not exist yet; add it to
// periodWarnings with that feature.
//
// Lock order: this closes ONE month per transaction (the year end is the close of December, one
// month, so there is no multi-month close). A future multi-month close must take the months' locks
// in ascending order and post its closing entries before setting status = 'closed': two closers
// that each already hold a shared lock on the same month would otherwise deadlock (Postgres aborts one).
//
// Reopening: only a closed month, newest first (period-rules.ts), with a written reason (the 0049 trigger also refuses a reopen
// without a new stamp and reason); clears the close override.

export interface PeriodRow {
  month: string;
  label: string;
  isTrial: boolean;
  status: "open" | "closed";
  ended: boolean;
  deadline: string;
  overdue: boolean;
  openIssueCount: number;
  warnings: string[];
  /** Official months still open: what closing would post as PPh final (D-20). */
  pphFinal: PphFinalProposal | null;
  /** December of an official year: closing also posts the year-end closing journal (§5.7). */
  closesYear: boolean;
  closeRefusal: string | null;
  closedAt: Date | null;
  closedByName: string | null;
  closeOverrideReason: string | null;
  reopenedAt: Date | null;
  reopenedByName: string | null;
  reopenedReason: string | null;
}

/** Unresolved posting issues a close of `month` would leave behind: every issue dated in the
 * official books up to the month's end (earlier official months are closed first, so their late
 * corrections land in this month, D-23), plus undated ones. */
async function countOpenIssues(db: Database, month: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(postingIssues)
    .where(
      and(
        isNull(postingIssues.resolvedAt),
        or(isNull(postingIssues.sourceDate), and(gte(postingIssues.sourceDate, OFFICIAL_BOOKS_START), lte(postingIssues.sourceDate, monthEndOf(month)))),
      ),
    );
  return row?.count ?? 0;
}

/** Σ debit and Σ credit of the month's set of books through the month's end (always equal while
 * the 0049 balance trigger holds; checked anyway before locking a month). */
async function trialBalanceTotals(db: Database, month: string): Promise<{ debitTotal: number; creditTotal: number }> {
  const [row] = (await db.execute(sql`
    select coalesce(sum(l.debit), 0)::bigint as debit_total, coalesce(sum(l.credit), 0)::bigint as credit_total
    from journal_lines l join journal_entries e on e.id = l.entry_id
    where e.entry_date between ${segmentStartOf(month)} and ${monthEndOf(month)}
  `)) as unknown as { debit_total: string; credit_total: string }[];
  return { debitTotal: Number(row?.debit_total ?? 0), creditTotal: Number(row?.credit_total ?? 0) };
}

/** D-20: the PPh final setting in force for the month has ended (or there is none). D-22: January
 * 2027 has no opening journal yet (closing it would then need a reopen to enter one). */
async function periodWarnings(db: Database, month: string): Promise<{ warnings: string[]; proposal: PphFinalProposal | null }> {
  const warnings: string[] = [];
  if (month === OFFICIAL_BOOKS_START) {
    const [opening] = await db.select({ id: journalEntries.id }).from(journalEntries).where(and(eq(journalEntries.kind, "opening"), isNull(journalEntries.reversedByEntryId))).limit(1);
    if (!opening) warnings.push("Saldo awal belum dibukukan. Bukukan saldo awal sebelum menutup Januari 2027.");
  }
  const proposal = await proposePphFinalFor(month, db);
  const taxWarning = proposal ? pphFinalWarning(proposal) : null;
  return { warnings: taxWarning ? [...warnings, taxWarning] : warnings, proposal };
}

export async function listPeriods(db: Database = defaultDb, now: Date = new Date()): Promise<PeriodRow[]> {
  const today = todayInJakarta(now);
  const closedBy = alias(staffUsers, "closed_by");
  const reopenedBy = alias(staffUsers, "reopened_by");
  const rows = await db
    .select({
      month: fiscalPeriods.month,
      status: fiscalPeriods.status,
      closedAt: fiscalPeriods.closedAt,
      closedByName: closedBy.name,
      closeOverrideReason: fiscalPeriods.closeOverrideReason,
      reopenedAt: fiscalPeriods.reopenedAt,
      reopenedByName: reopenedBy.name,
      reopenedReason: fiscalPeriods.reopenedReason,
    })
    .from(fiscalPeriods)
    .leftJoin(closedBy, eq(closedBy.id, fiscalPeriods.closedByStaffUserId))
    .leftJoin(reopenedBy, eq(reopenedBy.id, fiscalPeriods.reopenedByStaffUserId))
    .orderBy(asc(fiscalPeriods.month));
  const byMonth = new Map(rows.map((row) => [row.month, row]));
  const closedMonths = new Set(rows.filter((row) => row.status === "closed").map((row) => row.month));

  const months = periodMonthsToShow(today);
  return Promise.all(
    months.map(async (month): Promise<PeriodRow> => {
      const row = byMonth.get(month);
      const status = row?.status ?? "open";
      const isTrial = month < OFFICIAL_BOOKS_START;
      const ended = monthEndOf(month) < today;
      const deadline = closeDeadlineOf(month);
      const [openIssueCount, { warnings, proposal }] = isTrial
        ? [0, { warnings: [], proposal: null }]
        : await Promise.all([countOpenIssues(db, month), periodWarnings(db, month)]);
      const pphFinal = status === "open" ? proposal : null;
      return {
        month,
        label: monthLabel(month),
        isTrial,
        status,
        ended,
        deadline,
        overdue: !isTrial && status === "open" && today > deadline,
        openIssueCount,
        warnings,
        pphFinal,
        closesYear: !isTrial && month.slice(5, 7) === "12",
        closeRefusal: status === "closed" ? null : periodCloseRefusal(month, today, closedMonths),
        closedAt: row?.closedAt ?? null,
        closedByName: row?.closedByName ?? null,
        closeOverrideReason: row?.closeOverrideReason ?? null,
        reopenedAt: row?.reopenedAt ?? null,
        reopenedByName: row?.reopenedByName ?? null,
        reopenedReason: row?.reopenedReason ?? null,
      };
    }),
  );
}

/** Close `month` (D-23). `overrideReason` is required only while the month has open posting
 * issues; otherwise it is ignored. */
export async function closePeriod(month: string, overrideReason: string | null, actorStaffUserId: string, db: Database = defaultDb, now: Date = new Date()) {
  if (!isMonthStart(month)) throw new ActionError(PERIOD_MESSAGES.invalidMonth);
  const today = todayInJakarta(now);
  const reason = normalizeOptionalReason(overrideReason);
  if (reason !== null && reason.length > MAX_PERIOD_REASON_LENGTH) throw new FieldError("overrideReason", PERIOD_MESSAGES.overrideTooLong);

  return inReadCommitted(db, async (tx) => {
    // Locks in ascending month order: the previous month's (a concurrent reopen of it takes the same
    // lock, so "the earlier month is closed" cannot change under this close), then this month's
    // exclusive lock (every journal insert into this month holds it shared).
    if (month > OFFICIAL_BOOKS_START) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ammari.fiscal_period'), accounting_period_lock_key((${month}::date - interval '1 month')::date))`);
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ammari.fiscal_period'), accounting_period_lock_key(${month}::date))`);
    await tx.insert(fiscalPeriods).values({ month }).onConflictDoNothing();
    const [before] = await tx.select().from(fiscalPeriods).where(eq(fiscalPeriods.month, month)).for("update");
    if (!before) throw new Error(`fiscal period ${month} missing after insert`);
    // Re-read after the locks: a concurrent close or reopen of an earlier month is seen.
    const refusal = periodCloseRefusal(month, today, await loadClosedMonths(tx));
    if (refusal) throw new ActionError(refusal);

    const [openIssueCount, totals, { warnings }] = await Promise.all([countOpenIssues(tx, month), trialBalanceTotals(tx, month), periodWarnings(tx, month)]);
    if (totals.debitTotal !== totals.creditTotal) throw new ActionError(PERIOD_MESSAGES.unbalanced);
    if (openIssueCount > 0 && reason === null) throw new FieldError("overrideReason", PERIOD_MESSAGES.overrideRequired);

    // Session 11: the PPh final accrual and the year-end closing are computed from the ledger, so the
    // ledger must be up to date first: every source event dated in the official books through the
    // month's end is posted or explained by an open issue (Rekonsiliasi check 5). Otherwise a sale or
    // a depreciation the runner has not posted yet would be left out of the base and land, too late,
    // in the next open month.
    if (month >= OFFICIAL_BOOKS_START) {
      const completeness = await checkPostingCompleteness(tx as unknown as LedgerDatabase, { from: OFFICIAL_BOOKS_START, to: monthEndOf(month) }, { sources: defaultPostingSources(now) });
      if (completeness.gaps.length > 0) throw new ActionError(PERIOD_MESSAGES.postingStale(completeness.gaps.length));
    }

    // Session 11: the PPh final accrual and (December) the year-end closing, while the month is open.
    const postings = await postPeriodCloseJournals(tx, month, actorStaffUserId);

    const [after] = await tx
      .update(fiscalPeriods)
      .set({ status: "closed", closedAt: now, closedByStaffUserId: actorStaffUserId, closeOverrideReason: openIssueCount > 0 ? reason : null })
      .where(and(eq(fiscalPeriods.month, month), eq(fiscalPeriods.status, "open")))
      .returning();
    if (!after) throw new ActionError(PERIOD_MESSAGES.alreadyClosed);
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "close",
      entityType: "fiscal_period",
      entityId: month,
      before,
      after: { period: after, openIssueCount, warnings, ...totals, postings },
    });
    return after;
  });
}

/** Reopen `month` (D-23): only a closed month, with a written reason. */
export async function reopenPeriod(month: string, reason: string, actorStaffUserId: string, db: Database = defaultDb, now: Date = new Date()) {
  if (!isMonthStart(month)) throw new ActionError(PERIOD_MESSAGES.invalidMonth);
  const trimmed = reason.trim();
  if (trimmed === "") throw new FieldError("reason", PERIOD_MESSAGES.reopenReasonRequired);
  if (trimmed.length > MAX_PERIOD_REASON_LENGTH) throw new FieldError("reason", PERIOD_MESSAGES.reopenReasonTooLong);

  return inReadCommitted(db, async (tx) => {
    // The same exclusive lock a close takes, so a reopen and a close of this month serialise.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ammari.fiscal_period'), accounting_period_lock_key(${month}::date))`);
    const [before] = await tx.select().from(fiscalPeriods).where(eq(fiscalPeriods.month, month)).for("update");
    if (!before || before.status !== "closed") throw new ActionError(PERIOD_MESSAGES.notClosed);
    const refusal = periodReopenRefusal(month, await loadClosedMonths(tx));
    if (refusal) throw new ActionError(refusal);
    const [after] = await tx
      .update(fiscalPeriods)
      .set({ status: "open", reopenedAt: now, reopenedByStaffUserId: actorStaffUserId, reopenedReason: trimmed, closeOverrideReason: null })
      .where(eq(fiscalPeriods.month, month))
      .returning();
    if (!after) throw new Error(`failed to reopen ${month}`);
    await writeAuditLog(tx, { actorStaffUserId, action: "reopen", entityType: "fiscal_period", entityId: month, before, after });
    return after;
  });
}
