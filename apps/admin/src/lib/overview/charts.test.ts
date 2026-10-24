import { describe, expect, test } from "vitest";
import {
  axisLabelStep,
  bucketKeys,
  fillSeries,
  goalCumulativeSeries,
  MAX_DAILY_BARS,
  niceScale,
  salesChartWindow,
  scaleBps,
  shareBps,
} from "./charts";
import { goalWindow } from "./goal";
import { resolvePeriod } from "./period";

// docs/plans/dashboard-overview.md §4.2: daily bars up to 62 days, monthly beyond; Hari ini and
// Kemarin show the 14 days ending on that day. 08:00 WIB on 24 Oct 2026 is 01:00Z.

const morning = new Date("2026-10-24T01:00:00Z");
const iso = (date: Date) => date.toISOString();

describe("salesChartWindow", () => {
  test("Kemarin: 14 daily bars ending yesterday, the selected day is yesterday only", () => {
    const window = salesChartWindow(resolvePeriod({}, morning));
    expect(window).toMatchObject({ granularity: "day", fromDate: "2026-10-10", toDate: "2026-10-23", selectedFromDate: "2026-10-23", selectedToDate: "2026-10-23" });
    expect(iso(window.range.start)).toBe("2026-10-09T17:00:00.000Z");
    expect(iso(window.range.end)).toBe("2026-10-23T17:00:00.000Z");
    expect(bucketKeys(window.fromDate, window.toDate, window.granularity)).toHaveLength(14);
  });

  test("Hari ini: 14 days ending today, read up to now", () => {
    const window = salesChartWindow(resolvePeriod({ period: "today" }, morning));
    expect([window.fromDate, window.toDate]).toEqual(["2026-10-11", "2026-10-24"]);
    expect(iso(window.range.end)).toBe(iso(morning));
  });

  test("7 hari and Bulan ini are the period itself, one bar per day", () => {
    const week = salesChartWindow(resolvePeriod({ period: "7d" }, morning));
    expect([week.fromDate, week.toDate, week.granularity]).toEqual(["2026-10-18", "2026-10-24", "day"]);
    const month = salesChartWindow(resolvePeriod({ period: "month" }, morning));
    expect([month.fromDate, month.toDate, month.granularity]).toEqual(["2026-10-01", "2026-10-24", "day"]);
    expect(iso(month.range.end)).toBe(iso(morning));
  });

  test(`a custom range of ${MAX_DAILY_BARS} days stays daily; one day more is monthly`, () => {
    const daily = salesChartWindow(resolvePeriod({ period: "custom", from: "2026-08-01", to: "2026-10-01" }, morning));
    expect(daily.granularity).toBe("day");
    expect(bucketKeys(daily.fromDate, daily.toDate, "day")).toHaveLength(62);
    const monthly = salesChartWindow(resolvePeriod({ period: "custom", from: "2026-07-31", to: "2026-10-01" }, morning));
    expect(monthly.granularity).toBe("month");
    expect(bucketKeys(monthly.fromDate, monthly.toDate, "month")).toEqual(["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"]);
  });
});

describe("bucketKeys", () => {
  test("days cross a month and a leap day", () => {
    expect(bucketKeys("2028-02-28", "2028-03-01", "day")).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
  });

  test("months cross a year end", () => {
    expect(bucketKeys("2026-11-15", "2027-02-03", "month")).toEqual(["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"]);
  });
});

describe("fillSeries", () => {
  test("adds zero buckets in order; money stays null without finance.view_profit", () => {
    const keys = ["2026-10-22", "2026-10-23", "2026-10-24"];
    expect(fillSeries(keys, [{ key: "2026-10-23", orders: 2, pcs: 3, omzet: 500_000 }], true)).toEqual([
      { key: "2026-10-22", orders: 0, pcs: 0, omzet: 0 },
      { key: "2026-10-23", orders: 2, pcs: 3, omzet: 500_000 },
      { key: "2026-10-24", orders: 0, pcs: 0, omzet: 0 },
    ]);
    expect(fillSeries(keys, [], false).map((point) => point.omzet)).toEqual([null, null, null]);
  });
});

describe("niceScale", () => {
  test("money: round steps of 1, 2, 2,5 or 5 times a power of ten", () => {
    expect(niceScale(500_000)).toEqual({ max: 600_000, ticks: [0, 200_000, 400_000, 600_000] });
    expect(niceScale(1_000_000)).toEqual({ max: 1_000_000, ticks: [0, 250_000, 500_000, 750_000, 1_000_000] });
    expect(niceScale(3_200_000)).toEqual({ max: 4_000_000, ticks: [0, 1_000_000, 2_000_000, 3_000_000, 4_000_000] });
  });

  test("the top is never below the largest value", () => {
    for (const value of [1, 7, 99, 101, 12_345, 987_654_321]) {
      const scale = niceScale(value);
      expect(scale.max).toBeGreaterThanOrEqual(value);
      expect(scale.ticks[0]).toBe(0);
      expect(scale.ticks.at(-1)).toBe(scale.max);
    }
  });

  test("counts never get a fractional step", () => {
    expect(niceScale(3, { integer: true })).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(niceScale(10, { integer: true })).toEqual({ max: 10, ticks: [0, 5, 10] });
    expect(niceScale(7, { integer: true })).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8] });
    expect(niceScale(1, { integer: true }).ticks.every(Number.isInteger)).toBe(true);
  });

  test("an empty chart still has an axis", () => {
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(-5, { integer: true })).toEqual({ max: 1, ticks: [0, 1] });
  });
});

describe("scaleBps, shareBps, axisLabelStep", () => {
  test("bar heights are clamped basis points of the axis top", () => {
    expect(scaleBps(300_000, 600_000)).toBe(5_000);
    expect(scaleBps(0, 600_000)).toBe(0);
    expect(scaleBps(700, 600)).toBe(10_000);
    expect(scaleBps(5, 0)).toBe(0);
  });

  test("shares are basis points of the total, 0 for an empty total", () => {
    expect(shareBps(1, 3)).toBe(3_333);
    expect(shareBps(0, 0)).toBe(0);
  });

  test("at most 7 x labels", () => {
    expect(axisLabelStep(7)).toBe(1);
    expect(axisLabelStep(14)).toBe(2);
    expect(axisLabelStep(31)).toBe(5);
    expect(axisLabelStep(62)).toBe(9);
  });
});

describe("goalCumulativeSeries", () => {
  const window = goalWindow({ revenueTargetAmount: 1_000_000_000, startDate: "2026-11-01" })!;

  test("12 months for a year starting on the 1st; the straight line reaches the target on the last day", () => {
    const series = goalCumulativeSeries(window, 1_000_000_000, new Map(), "2026-10-24");
    expect(series).toHaveLength(12);
    expect(series[0]).toEqual({ month: "2026-11-01", expected: Math.round((1_000_000_000 * 30) / 365), actual: null });
    expect(series.at(-1)).toEqual({ month: "2027-10-01", expected: 1_000_000_000, actual: null });
  });

  test("actual is cumulative through this month; later months stay empty", () => {
    const omzet = new Map([
      ["2026-11-01", 50_000_000],
      ["2026-12-01", 70_000_000],
      ["2027-01-01", 10_000_000],
    ]);
    const series = goalCumulativeSeries(window, 1_000_000_000, omzet, "2027-01-05");
    expect(series.slice(0, 4).map((point) => point.actual)).toEqual([50_000_000, 120_000_000, 130_000_000, null]);
  });

  test("a mid-month start has a part month at both ends", () => {
    const midMonth = goalWindow({ revenueTargetAmount: 365, startDate: "2026-11-15" })!;
    const series = goalCumulativeSeries(midMonth, 365, new Map(), "2026-11-20");
    expect(series.map((point) => point.month)).toEqual(bucketKeys("2026-11-01", "2027-11-01", "month"));
    expect(series[0]).toEqual({ month: "2026-11-01", expected: 16, actual: 0 });
    expect(series.at(-1)?.expected).toBe(365);
  });
});
