import { ACCOUNTING_TRIAL_MONTH } from "@ammari/db/schema";

// Asia/Jakarta calendar dates for the ledger (docs/plans/accounting.md: periods are Jakarta
// calendar months). A calendar date is a "YYYY-MM-DD" string; WIB is a fixed UTC+7 with no
// daylight saving. Kept here (not imported from @ammari/commerce) so the ledger depends on
// @ammari/db only.

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The first day the engine posts (the cut-over filter, plan §2): December 2026, the trial month
 * (D-22: posted, never locked, not part of the official books). A source event dated earlier
 * lives in the opening balances, never in a journal. */
export const POSTING_START_DATE = ACCOUNTING_TRIAL_MONTH;

/** The Jakarta calendar date of an instant: 2026-12-31T17:30:00Z -> "2027-01-01". */
export function jakartaDateOf(instant: Date): string {
  return new Date(instant.getTime() + JAKARTA_OFFSET_MS).toISOString().slice(0, 10);
}

export function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return false;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(ms).toISOString().slice(0, 10) === value;
}

/** "2027-01-17" -> "2027-01-01". */
export function monthStartOf(date: string): string {
  if (!isCalendarDate(date)) throw new Error(`not a calendar date: "${date}"`);
  return `${date.slice(0, 7)}-01`;
}

/** "2026-12-01" -> "2027-01-01". */
export function nextMonthStart(month: string): string {
  const start = monthStartOf(month);
  const year = Number(start.slice(0, 4));
  const monthIndex = Number(start.slice(5, 7));
  return monthIndex === 12 ? `${year + 1}-01-01` : `${year}-${String(monthIndex + 1).padStart(2, "0")}-01`;
}

/** The last day of the month `date` falls in. */
export function monthEndOf(date: string): string {
  const next = nextMonthStart(date);
  const ms = Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5, 7)) - 1, 1) - 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** The date an entry for `sourceDate` is booked on (plan §2, D-23): the source date itself when
 * its month is open, otherwise the first day of the first open month after it. `closedMonths`
 * holds first-of-month dates of closed periods (no row = open). */
export function postingDateFor(sourceDate: string, closedMonths: ReadonlySet<string>): string {
  let month = monthStartOf(sourceDate);
  if (!closedMonths.has(month)) return sourceDate;
  // Bounded: there are only so many closed months; the loop always reaches an open one.
  for (let guard = 0; guard < 1200; guard += 1) {
    month = nextMonthStart(month);
    if (!closedMonths.has(month)) return month;
  }
  throw new Error(`no open accounting period after ${sourceDate}`);
}
