// Asia/Jakarta calendar days (docs/plans/dashboard-overview.md §3.1, §7). A calendar date is a
// "YYYY-MM-DD" string, never a Date: a Date is an instant, and "today" / a deadline / a report
// period is a Jakarta day. WIB is a fixed UTC+7 with no daylight saving, so a Jakarta midnight is
// always 17:00 UTC of the previous day. Range queries use those instants
// (`col >= jakartaMidnight(from) and col < jakartaMidnight(to + 1)`), so an index on a timestamptz
// column stays usable; never convert the column itself in a WHERE.

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** UTC midnight of `date`, used only as an arithmetic carrier for calendar math. */
function utcMidnight(date: string): number {
  const match = CALENDAR_DATE.exec(date);
  if (!match) throw new Error(`not a calendar date: "${date}"`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  // Date.UTC rolls 2026-02-30 over to 2 March; a round trip catches it.
  if (formatUtc(ms) !== date) throw new Error(`not a calendar date: "${date}"`);
  return ms;
}

function formatUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isCalendarDate(value: string | undefined | null): value is string {
  if (typeof value !== "string") return false;
  try {
    utcMidnight(value);
    return true;
  } catch {
    return false;
  }
}

/** The Asia/Jakarta calendar date of an instant, e.g. 2026-10-31T17:30:00Z -> "2026-11-01". */
export function jakartaDate(now: Date = new Date()): string {
  return formatUtc(now.getTime() + JAKARTA_OFFSET_MS);
}

/** 00:00 WIB of `date`, as an instant. */
export function jakartaMidnight(date: string): Date {
  return new Date(utcMidnight(date) - JAKARTA_OFFSET_MS);
}

export function addCalendarDays(date: string, days: number): string {
  return formatUtc(utcMidnight(date) + days * DAY_MS);
}

/** Same month and day `years` later; 29 February rolls to 1 March in a non-leap year. */
export function addCalendarYears(date: string, years: number): string {
  const ms = utcMidnight(date);
  const source = new Date(ms);
  return formatUtc(Date.UTC(source.getUTCFullYear() + years, source.getUTCMonth(), source.getUTCDate()));
}

/** `to - from` in whole days (negative when `to` is earlier). */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / DAY_MS);
}
