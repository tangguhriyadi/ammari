import { ACCOUNTING_CUTOVER_DATE, ACCOUNTING_TRIAL_MONTH, ACCOUNTING_TRIAL_MONTH_END } from "@ammari/db/schema";

// How the December 2026 trial month and the official books coexist (D-22; docs/plans/accounting.md
// §5.4 "Trial month and official books", settled in Session 4).
//
// The ledger holds two separate sets of books, split by entry_date:
//   - the trial books: entries dated 2026-12-01..2026-12-31. The engine posts them (and they are
//     never closed) so December exercises every rule, but they are practice only;
//   - the official books: entries dated on or after the cut-over 2027-01-01. They start from ONE
//     opening journal dated 2027-01-01 (as of 31 Dec 2026), whose lines come from the source
//     ledgers and the typed bank/platform balances, never from December's journals.
//
// Every balance is therefore summed within one segment only: a report's opening balance starts at
// its segment's first day (1 Dec 2026 for the trial books, 1 Jan 2027 for the official books), so
// December's journals can never leak into a 2027 opening balance, Buku besar or Neraca saldo, and a
// report range never mixes the two (a range crossing the cut-over starts at the cut-over). And a
// void (or any event that only negates an original) never crosses the cut-over: an original
// journaled in the trial books whose void is dated in 2027 posts nothing in 2027, because the
// opening journal already reflects what the void corrects (runner.ts, `crossesCutover`).

export type BookSegment = "before" | "trial" | "official";

export const TRIAL_BOOKS_START = ACCOUNTING_TRIAL_MONTH;
export const TRIAL_BOOKS_END = ACCOUNTING_TRIAL_MONTH_END;
export const OFFICIAL_BOOKS_START = ACCOUNTING_CUTOVER_DATE;

/** Which set of books a Jakarta calendar date belongs to. */
export function bookSegmentOf(date: string): BookSegment {
  if (date < TRIAL_BOOKS_START) return "before";
  if (date < OFFICIAL_BOOKS_START) return "trial";
  return "official";
}

/** The first day of the segment `date` belongs to (balances are summed from here). A date before
 * the trial month has no books: its own date (nothing is ever posted before the trial month). */
export function segmentStartOf(date: string): string {
  switch (bookSegmentOf(date)) {
    case "trial":
      return TRIAL_BOOKS_START;
    case "official":
      return OFFICIAL_BOOKS_START;
    case "before":
      return date;
  }
}

/** True when the two dates are in different sets of books. */
export function crossesCutover(originalDate: string, laterDate: string): boolean {
  return bookSegmentOf(originalDate) !== bookSegmentOf(laterDate);
}

export interface ReportRange {
  from: string;
  to: string;
  /** Balances before `from` are summed from here (the segment's first day). */
  segmentStart: string;
  segment: BookSegment;
  /** `from` was moved so the range stays inside one set of books. */
  adjusted: boolean;
}

/** A report range kept inside one set of books. The later end decides: a range reaching into the
 * official books starts no earlier than the cut-over; a range ending in the trial month starts no
 * earlier than the trial month. `from <= to` is assumed (the filters swap a reversed range). */
export function resolveReportRange(range: { from: string; to: string }): ReportRange {
  const segment = bookSegmentOf(range.to);
  const start = segment === "before" ? range.from : segmentStartOf(range.to);
  const from = range.from < start ? start : range.from;
  return { from, to: range.to, segmentStart: start, segment, adjusted: from !== range.from };
}
