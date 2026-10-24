import { formatDate, formatNumber, formatShortDate } from "@ammari/ui/lib";
import { calendarDaysBetween, jakartaMidnight } from "@ammari/commerce/jakarta-day";
import type { ResolvedPeriod } from "./period";

// Display helpers for Ringkasan (docs/plans/dashboard-overview.md §3.2, §8). Pure. Indonesian
// number style (dot thousands, comma decimals), percentages from integer basis points.

const decimalFormatter = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 0, maximumFractionDigits: 1 });

const COMPACT_UNITS = [
  { value: 1_000_000_000_000, suffix: "T" },
  { value: 1_000_000_000, suffix: "M" },
  { value: 1_000_000, suffix: "jt" },
  { value: 1_000, suffix: "rb" },
] as const;

/** "Rp 3,2 jt", "Rp 850 rb", "Rp 1,5 M"; below Rp 1.000 the full amount. Rounded down to one
 * decimal, so a tile never shows more than was sold ("Rp 999.999" is "Rp 999,9 rb", not "Rp 1 jt"). */
export function formatCompactRupiah(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const absolute = Math.abs(amount);
  const unit = COMPACT_UNITS.find((candidate) => absolute >= candidate.value);
  if (!unit) return `${sign}Rp ${formatNumber(absolute)}`;
  const scaled = Math.floor((absolute * 10) / unit.value) / 10;
  return `${sign}Rp ${decimalFormatter.format(scaled)} ${unit.suffix}`;
}

/** formatCompactRupiah without "Rp " ("3,2 jt"), for a chart axis whose title already says
 * Omzet: it keeps the tick labels short enough for a phone. */
export function formatCompactAmount(amount: number): string {
  return formatCompactRupiah(amount).replace("Rp ", "");
}

/** 2345 -> "23,4%", 10000 -> "100%". Rounded toward zero: 99,99% is not "100%", and a -0,05%
 * margin is not "-0,1%". */
export function formatPercentBps(bps: number): string {
  const tenths = Math.trunc(bps / 10) / 10 || 0;
  return `${decimalFormatter.format(tenths)}%`;
}

export type DeltaDirection = "up" | "down" | "same" | "none";

export interface Delta {
  direction: DeltaDirection;
  /** |current - previous| / previous in basis points; null when there is nothing to compare. */
  changeBps: number | null;
}

/** "none" when the comparison period had nothing (no percentage of 0 exists). */
export function computeDelta(current: number, previous: number): Delta {
  if (previous === 0) return { direction: current === 0 ? "same" : "none", changeBps: current === 0 ? 0 : null };
  if (current === previous) return { direction: "same", changeBps: 0 };
  const changeBps = Math.round((Math.abs(current - previous) * 10_000) / Math.abs(previous));
  return { direction: current > previous ? "up" : "down", changeBps };
}

/** The percentage of a delta: whole percent from 10%, one decimal below, "<0,1%" for a tiny change. */
export function formatDeltaPercent(changeBps: number): string {
  if (changeBps >= 1_000) return `${formatNumber(Math.round(changeBps / 100))}%`;
  if (changeBps > 0 && changeBps < 10) return "<0,1%";
  return `${decimalFormatter.format(Math.round(changeBps / 10) / 10)}%`;
}

const monthFormatter = new Intl.DateTimeFormat("id-ID", { month: "short", timeZone: "UTC" });
const monthYearFormatter = new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "UTC" });

/** "Nov" for "2026-11-01" (a chart's month bucket). */
export function formatMonthShort(month: string): string {
  return monthFormatter.format(new Date(`${month.slice(0, 7)}-01T00:00:00Z`));
}

/** "November 2026" for "2026-11-01". */
export function formatMonthYear(month: string): string {
  return monthYearFormatter.format(new Date(`${month.slice(0, 7)}-01T00:00:00Z`));
}

/** "1 Nov 2026" for a Jakarta calendar date. */
export function formatCalendarDate(date: string): string {
  return formatDate(jakartaMidnight(date));
}

/** "23 Okt 2026" or "17 Okt s.d. 23 Okt 2026" (the year once when both ends share it). */
export function formatDateRange(fromDate: string, toDate: string): string {
  if (fromDate === toDate) return formatCalendarDate(fromDate);
  const from = fromDate.slice(0, 4) === toDate.slice(0, 4) ? formatShortDate(jakartaMidnight(fromDate)) : formatCalendarDate(fromDate);
  return `${from} s.d. ${formatCalendarDate(toDate)}`;
}

/** The "dibanding ..." half of a tile's delta line. */
export function comparisonLabel(resolved: ResolvedPeriod): string {
  switch (resolved.period) {
    case "today":
      return "kemarin di jam yang sama";
    case "yesterday":
      return formatCalendarDate(resolved.previousFromDate);
    case "7d":
      return "7 hari sebelumnya";
    case "month":
      return "periode yang sama bulan lalu";
    case "custom": {
      const days = calendarDaysBetween(resolved.fromDate, resolved.toDate) + 1;
      return days === 1 ? formatCalendarDate(resolved.previousFromDate) : `${days} hari sebelumnya`;
    }
  }
}
