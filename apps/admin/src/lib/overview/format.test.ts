import { describe, expect, test } from "vitest";
import {
  comparisonLabel,
  computeDelta,
  formatCompactRupiah,
  formatDateRange,
  formatDeltaPercent,
  formatPercentBps,
} from "./format";
import { resolvePeriod } from "./period";

describe("formatCompactRupiah", () => {
  test("uses rb / jt / M with one decimal, rounded down", () => {
    expect(formatCompactRupiah(0)).toBe("Rp 0");
    expect(formatCompactRupiah(950)).toBe("Rp 950");
    expect(formatCompactRupiah(850_000)).toBe("Rp 850 rb");
    expect(formatCompactRupiah(3_249_000)).toBe("Rp 3,2 jt");
    expect(formatCompactRupiah(999_999)).toBe("Rp 999,9 rb");
    expect(formatCompactRupiah(12_000_000)).toBe("Rp 12 jt");
    expect(formatCompactRupiah(1_000_000_000)).toBe("Rp 1 M");
    expect(formatCompactRupiah(1_560_000_000)).toBe("Rp 1,5 M");
  });

  test("a negative laba kotor keeps its sign", () => {
    expect(formatCompactRupiah(-1_250_000)).toBe("-Rp 1,2 jt");
  });
});

describe("formatPercentBps", () => {
  test("one decimal, rounded down, past 100% allowed", () => {
    expect(formatPercentBps(0)).toBe("0%");
    expect(formatPercentBps(2345)).toBe("23,4%");
    expect(formatPercentBps(9999)).toBe("99,9%");
    expect(formatPercentBps(10_000)).toBe("100%");
    expect(formatPercentBps(12_500)).toBe("125%");
    // A negative margin (HPP above omzet) rounds toward zero too.
    expect(formatPercentBps(-2345)).toBe("-23,4%");
    expect(formatPercentBps(-5)).toBe("0%");
  });
});

describe("computeDelta", () => {
  test("up and down, as basis points of the previous value", () => {
    expect(computeDelta(112, 100)).toEqual({ direction: "up", changeBps: 1200 });
    expect(computeDelta(92, 100)).toEqual({ direction: "down", changeBps: 800 });
  });

  test("from 0 there is nothing to compare; to 0 is a 100% drop; both 0 is unchanged", () => {
    expect(computeDelta(5, 0)).toEqual({ direction: "none", changeBps: null });
    expect(computeDelta(0, 5)).toEqual({ direction: "down", changeBps: 10_000 });
    expect(computeDelta(0, 0)).toEqual({ direction: "same", changeBps: 0 });
    expect(computeDelta(7, 7)).toEqual({ direction: "same", changeBps: 0 });
  });

  test("a negative previous value (a loss) still gives a positive percentage", () => {
    expect(computeDelta(50, -100)).toEqual({ direction: "up", changeBps: 15_000 });
  });
});

describe("formatDeltaPercent", () => {
  test("whole percent from 10%, one decimal below", () => {
    expect(formatDeltaPercent(1_249)).toBe("12%");
    expect(formatDeltaPercent(10_000)).toBe("100%");
    expect(formatDeltaPercent(125_000)).toBe("1.250%");
    expect(formatDeltaPercent(840)).toBe("8,4%");
    expect(formatDeltaPercent(5)).toBe("<0,1%");
  });
});

describe("date labels", () => {
  test("a single day, a range in one year, a range across years", () => {
    expect(formatDateRange("2026-10-23", "2026-10-23")).toBe("23 Okt 2026");
    expect(formatDateRange("2026-10-17", "2026-10-23")).toBe("17 Okt s.d. 23 Okt 2026");
    expect(formatDateRange("2026-12-28", "2027-01-03")).toBe("28 Des 2026 s.d. 3 Jan 2027");
  });

  test("comparisonLabel names what each period is compared with", () => {
    const now = new Date("2026-10-24T01:00:00Z"); // 08:00 WIB
    expect(comparisonLabel(resolvePeriod({}, now))).toBe("22 Okt 2026");
    expect(comparisonLabel(resolvePeriod({ period: "today" }, now))).toBe("kemarin di jam yang sama");
    expect(comparisonLabel(resolvePeriod({ period: "7d" }, now))).toBe("7 hari sebelumnya");
    expect(comparisonLabel(resolvePeriod({ period: "month" }, now))).toBe("periode yang sama bulan lalu");
    expect(comparisonLabel(resolvePeriod({ period: "custom", from: "2026-10-01", to: "2026-10-10" }, now))).toBe("10 hari sebelumnya");
    expect(comparisonLabel(resolvePeriod({ period: "custom", from: "2026-10-10", to: "2026-10-10" }, now))).toBe("9 Okt 2026");
  });
});
