import { describe, expect, test } from "vitest";
import { calculateBatasHpp, type CostAssumptionRates } from "./batas-hpp";

// The initial cost_assumptions row (docs/SPEC.md §7): 18% marketplace fee, 12% ads, 3% returns
// reserve, 20% target profit — sums to 53%, so the margin is 47%, and packaging is Rp 4.000.
const SEEDED_RATES: CostAssumptionRates = {
  marketplaceFeeBps: 1800,
  adsBps: 1200,
  returnsReserveBps: 300,
  targetProfitBps: 2000,
  packagingCostAmount: 4000,
};

describe("calculateBatasHpp", () => {
  test("matches 'base price x 47% - Rp4.000' for the seeded assumptions", () => {
    expect(calculateBatasHpp(269_000, SEEDED_RATES)).toBe(Math.round(269_000 * 0.47) - 4000);
  });

  test("a different base price scales proportionally", () => {
    expect(calculateBatasHpp(229_000, SEEDED_RATES)).toBe(Math.round(229_000 * 0.47) - 4000);
  });

  test("rounds to the nearest whole rupiah rather than truncating", () => {
    // 100.000 * 0.47 = 47.000 exactly, so pick an amount that doesn't divide evenly.
    const rates: CostAssumptionRates = { ...SEEDED_RATES, targetProfitBps: 2001 };
    const expected = Math.round((100_000 * (10_000 - 1800 - 1200 - 300 - 2001)) / 10_000) - 4000;
    expect(calculateBatasHpp(100_000, rates)).toBe(expected);
  });

  test("derives from whatever assumptions are passed in, not a hardcoded 47%/4000", () => {
    const stricter: CostAssumptionRates = {
      marketplaceFeeBps: 2000,
      adsBps: 1500,
      returnsReserveBps: 500,
      targetProfitBps: 2500,
      packagingCostAmount: 5000,
    };
    // margin = 100 - 20 - 15 - 5 - 25 = 35%
    expect(calculateBatasHpp(200_000, stricter)).toBe(Math.round(200_000 * 0.35) - 5000);
  });
});
