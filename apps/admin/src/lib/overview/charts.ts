import { addCalendarDays, calendarDaysBetween, jakartaMidnight } from "@ammari/commerce/jakarta-day";
import type { GoalWindow } from "./goal";
import type { ResolvedPeriod, TimeRange } from "./period";

// Ringkasan chart math (docs/plans/dashboard-overview.md §4). Pure: which days or months a chart
// covers, how missing buckets are filled, and the axis scale. The SVG components only draw what
// these return, so every number they place is unit tested here.

export type SeriesGranularity = "day" | "month";

/** Up to this many days the sales chart has one bar per day; a longer range has one per month. */
export const MAX_DAILY_BARS = 62;

/** "Hari ini" and "Kemarin" are one day, and one bar is not a chart: show this many days ending
 * on that day (§4.2). */
export const SHORT_PERIOD_CONTEXT_DAYS = 14;

/** At most this many x-axis labels, so each stays readable on a 390px phone. */
export const MAX_AXIS_LABELS = 7;

export interface SalesChartWindow {
  granularity: SeriesGranularity;
  /** Jakarta calendar dates the bars cover, inclusive. */
  fromDate: string;
  toDate: string;
  /** What the query reads; ends at `now` when the window includes today. */
  range: TimeRange;
  /** The selected period inside the window (the rest is context, drawn muted). */
  selectedFromDate: string;
  selectedToDate: string;
}

export function salesChartWindow(resolved: ResolvedPeriod): SalesChartWindow {
  const selected = { selectedFromDate: resolved.fromDate, selectedToDate: resolved.toDate };
  if (resolved.period === "today" || resolved.period === "yesterday") {
    const fromDate = addCalendarDays(resolved.toDate, -(SHORT_PERIOD_CONTEXT_DAYS - 1));
    return {
      granularity: "day",
      fromDate,
      toDate: resolved.toDate,
      range: { start: jakartaMidnight(fromDate), end: resolved.current.end },
      ...selected,
    };
  }
  const days = calendarDaysBetween(resolved.fromDate, resolved.toDate) + 1;
  return {
    granularity: days > MAX_DAILY_BARS ? "month" : "day",
    fromDate: resolved.fromDate,
    toDate: resolved.toDate,
    range: resolved.current,
    ...selected,
  };
}

/** "YYYY-MM-01" of a calendar date. */
export function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7));
  return monthIndex === 12 ? `${year + 1}-01-01` : `${year}-${String(monthIndex + 1).padStart(2, "0")}-01`;
}

/** Every bucket key of a window, in order: each date, or each month's first day. */
export function bucketKeys(fromDate: string, toDate: string, granularity: SeriesGranularity): string[] {
  const keys: string[] = [];
  if (granularity === "day") {
    for (let date = fromDate; date <= toDate; date = addCalendarDays(date, 1)) keys.push(date);
    return keys;
  }
  for (let month = monthOf(fromDate); month <= monthOf(toDate); month = nextMonth(month)) keys.push(month);
  return keys;
}

export interface SeriesPoint {
  /** A bucket key from bucketKeys. */
  key: string;
  orders: number;
  pcs: number;
  /** Null without finance.view_profit. */
  omzet: number | null;
}

/** One point per bucket, zero where nothing sold (the query only returns buckets with sales). */
export function fillSeries(keys: readonly string[], rows: readonly SeriesPoint[], canViewProfit: boolean): SeriesPoint[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return keys.map((key) => byKey.get(key) ?? { key, orders: 0, pcs: 0, omzet: canViewProfit ? 0 : null });
}

export interface AxisScale {
  /** The top of the axis, at least the largest value. */
  max: number;
  /** From 0 up to `max`, evenly spaced. */
  ticks: number[];
}

const NICE_STEPS = [1, 2, 2.5, 5, 10] as const;

/**
 * A round axis for values up to `maxValue`: about `targetTicks` steps of 1, 2, 2,5 or 5 times a
 * power of ten. Counts (`integer`) never get a fractional step. An empty chart still gets an axis
 * (0 to 1 for counts, 0 to Rp 1.000 for money is the caller's choice of `maxValue`).
 */
export function niceScale(maxValue: number, { targetTicks = 4, integer = false }: { targetTicks?: number; integer?: boolean } = {}): AxisScale {
  const top = Math.max(maxValue, 0);
  if (top === 0) return { max: 1, ticks: [0, 1] };
  const rough = top / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  // A 2,5 step of a count below 10 would be fractional; counts step 1, 2, 5, 10.
  const steps = integer && magnitude < 10 ? NICE_STEPS.filter((candidate) => candidate !== 2.5) : NICE_STEPS;
  let step = (steps.find((candidate) => candidate * magnitude >= rough) ?? 10) * magnitude;
  if (integer) step = Math.max(1, Math.round(step));
  const max = Math.ceil(top / step) * step;
  const ticks: number[] = [];
  // Built from the index, not by adding steps, so 2,5-steps never drift (0.1 + 0.2).
  for (let index = 0; index * step <= max + step / 1e9; index += 1) ticks.push(Math.round(index * step * 1e6) / 1e6);
  return { max, ticks };
}

/** `value / max` in basis points, clamped to 0..10000. */
export function scaleBps(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(Math.max(Math.round((value * 10_000) / max), 0), 10_000);
}

/** Show every n-th x-axis label so at most `maxLabels` appear (XAxisLabels counts the step from
 * the last bar, so the newest one is always labelled). */
export function axisLabelStep(count: number, maxLabels: number = MAX_AXIS_LABELS): number {
  return Math.max(1, Math.ceil(count / maxLabels));
}

/** `part / whole` in basis points (a share of a total), 0 for an empty total. */
export function shareBps(part: number, whole: number): number {
  return whole > 0 ? Math.round((part * 10_000) / whole) : 0;
}

// ---------- Target tracker: cumulative actual vs straight-line target (§2.3, §4.1) ----------

export interface CumulativePoint {
  /** "YYYY-MM-01". */
  month: string;
  /** Where the straight line to the target stands at the month's last goal day. */
  expected: number;
  /** Omzet from the goal start through the month's end (through today for this month); null for
   * a month that has not started yet. */
  actual: number | null;
}

/**
 * One point per calendar month of the goal year. A year starting mid-month has 13 points (a part
 * month at each end). `monthlyOmzet` is keyed by month ("YYYY-MM-01") and holds only goal days.
 */
export function goalCumulativeSeries(
  window: GoalWindow,
  targetAmount: number,
  monthlyOmzet: ReadonlyMap<string, number>,
  today: string,
): CumulativePoint[] {
  let running = 0;
  return bucketKeys(window.startDate, window.endDate, "month").map((month) => {
    const lastDayOfMonth = addCalendarDays(nextMonth(month), -1);
    const monthEnd = lastDayOfMonth < window.endDate ? lastDayOfMonth : window.endDate;
    const goalDays = calendarDaysBetween(window.startDate, monthEnd) + 1;
    const expected = Math.round((targetAmount * goalDays) / window.totalDays);
    if (month > today) return { month, expected, actual: null };
    running += monthlyOmzet.get(month) ?? 0;
    return { month, expected, actual: running };
  });
}
