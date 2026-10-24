import { addCalendarDays, calendarDaysBetween, isCalendarDate, jakartaDate, jakartaMidnight } from "@ammari/commerce/jakarta-day";

// The Ringkasan period selector (docs/plans/dashboard-overview.md §3.1). Pure: the page passes its
// search params and the current instant; every boundary is a Jakarta midnight as a UTC instant, so
// the queries filter `order_date >= start and order_date < end` and keep using its index.

export const OVERVIEW_PERIODS = ["today", "yesterday", "7d", "month", "custom"] as const;
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number];

/** Owner decision D5: the full previous day is the useful number at 07:00. */
export const DEFAULT_OVERVIEW_PERIOD: OverviewPeriod = "yesterday";

/** Longest custom range, inclusive of both ends. */
export const MAX_CUSTOM_PERIOD_DAYS = 366;

/** Half-open: `start <= t < end`. */
export interface TimeRange {
  start: Date;
  end: Date;
}

export interface ResolvedPeriod {
  period: OverviewPeriod;
  /** Jakarta calendar dates shown to the user, inclusive. */
  fromDate: string;
  toDate: string;
  current: TimeRange;
  /** The comparison period ("dibanding ..."). */
  previous: TimeRange;
  /** Its Jakarta calendar dates, inclusive, for the "dibanding" label. */
  previousFromDate: string;
  previousToDate: string;
}

export interface PeriodParams {
  period?: string;
  from?: string;
  to?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function withPreviousDates(resolved: Omit<ResolvedPeriod, "previousFromDate" | "previousToDate">): ResolvedPeriod {
  const { start, end } = resolved.previous;
  // `end` is exclusive; an empty range (00:00 WIB on the 1st) still names its start day.
  const lastInstant = new Date(Math.max(end.getTime() - 1, start.getTime()));
  return { ...resolved, previousFromDate: jakartaDate(start), previousToDate: jakartaDate(lastInstant) };
}

/** `days` whole calendar days ending on `toDate`, stopped at `now` when `toDate` is today, and the
 * same stretch shifted back by `days` days (so "today until 08:00" compares with "yesterday until
 * 08:00"). Shifting by `days * 24h` is exact because WIB has no daylight saving (jakarta-day.ts). */
function dayRange(period: OverviewPeriod, fromDate: string, toDate: string, now: Date): ResolvedPeriod {
  const days = calendarDaysBetween(fromDate, toDate) + 1;
  const start = jakartaMidnight(fromDate);
  const end = new Date(Math.min(jakartaMidnight(addCalendarDays(toDate, 1)).getTime(), now.getTime()));
  const shift = days * DAY_MS;
  return withPreviousDates({
    period,
    fromDate,
    toDate,
    current: { start, end },
    previous: { start: new Date(start.getTime() - shift), end: new Date(end.getTime() - shift) },
  });
}

function monthToDate(today: string, now: Date): ResolvedPeriod {
  const firstOfMonth = `${today.slice(0, 8)}01`;
  const firstOfLastMonth = `${addCalendarDays(firstOfMonth, -1).slice(0, 8)}01`;
  const start = jakartaMidnight(firstOfMonth);
  const previousStart = jakartaMidnight(firstOfLastMonth);
  const elapsed = now.getTime() - start.getTime();
  // Capped at the start of this month: 31 March compares with the whole of February, never with
  // the first days of March.
  const previousEnd = new Date(Math.min(previousStart.getTime() + elapsed, start.getTime()));
  return withPreviousDates({
    period: "month",
    fromDate: firstOfMonth,
    toDate: today,
    current: { start, end: now },
    previous: { start: previousStart, end: previousEnd },
  });
}

/** The custom range when it is valid: real dates, `from <= to <= today`, at most 366 days. */
function customRange(params: PeriodParams, today: string): { from: string; to: string } | null {
  const { from, to } = params;
  if (!isCalendarDate(from) || !isCalendarDate(to)) return null;
  const span = calendarDaysBetween(from, to) + 1;
  return span >= 1 && span <= MAX_CUSTOM_PERIOD_DAYS && calendarDaysBetween(to, today) >= 0 ? { from, to } : null;
}

/** Never throws on user input: an unknown period or an invalid custom range is the default. */
export function resolvePeriod(params: PeriodParams, now: Date = new Date()): ResolvedPeriod {
  const today = jakartaDate(now);
  const requested = OVERVIEW_PERIODS.find((period) => period === params.period) ?? DEFAULT_OVERVIEW_PERIOD;
  if (requested === "custom") {
    const range = customRange(params, today);
    return range ? dayRange("custom", range.from, range.to, now) : resolvePeriod({}, now);
  }
  switch (requested) {
    case "today":
      return dayRange(requested, today, today, now);
    case "yesterday": {
      const yesterday = addCalendarDays(today, -1);
      return dayRange(requested, yesterday, yesterday, now);
    }
    case "7d":
      return dayRange(requested, addCalendarDays(today, -6), today, now);
    case "month":
      return monthToDate(today, now);
  }
}
