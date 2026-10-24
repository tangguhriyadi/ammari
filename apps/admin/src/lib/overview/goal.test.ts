import { describe, expect, test } from "vitest";
import { computeGoalProgress, goalWindow } from "./goal";

// docs/plans/dashboard-overview.md §2.3 (D3: 1 Nov 2026 start, D4: straight-line pace).

const goal = { revenueTargetAmount: 1_000_000_000, startDate: "2026-11-01" };
const noRecentSales = { omzet: 0, pcs: 0 };

describe("goalWindow", () => {
  test("runs one year minus a day, leap years included", () => {
    expect(goalWindow(goal)).toEqual({ startDate: "2026-11-01", endDate: "2027-10-31", totalDays: 365 });
    expect(goalWindow({ ...goal, startDate: "2027-03-01" })).toEqual({ startDate: "2027-03-01", endDate: "2028-02-29", totalDays: 366 });
    expect(goalWindow({ ...goal, startDate: null })).toBeNull();
  });
});

describe("computeGoalProgress", () => {
  test("not configured without a start date", () => {
    expect(computeGoalProgress({ ...goal, startDate: null }, "2026-11-10", 0, noRecentSales)).toEqual({ state: "not_configured" });
  });

  test("before the start there is no pace yet", () => {
    expect(computeGoalProgress(goal, "2026-10-24", 0, noRecentSales)).toEqual({
      state: "not_started",
      targetAmount: 1_000_000_000,
      startDate: "2026-11-01",
      endDate: "2027-10-31",
    });
  });

  test("day 1 counts as elapsed: expected is one day's share, behind with nothing sold", () => {
    const progress = computeGoalProgress(goal, "2026-11-01", 0, noRecentSales);
    expect(progress).toMatchObject({
      state: "active",
      elapsedDays: 1,
      daysLeft: 365,
      expectedAmount: 2_739_726, // floor(1e9 / 365)
      status: "behind",
      gapAmount: 2_739_726,
      remainingAmount: 1_000_000_000,
      neededPerDay: 2_739_727, // ceil(1e9 / 365)
      neededPerMonth: 82_191_810,
      progressBps: 0,
      neededPcsPerDay: null, // fewer than 10 pcs sold recently: no average price to convert with
    });
  });

  test("on track mid-year, with the needed pace in pieces from the recent average price", () => {
    // 1 May 2027 is day 182; expected floor(1e9 * 182 / 365) = 498_630_136.
    const progress = computeGoalProgress(goal, "2027-05-01", 500_000_000, { omzet: 25_900_000, pcs: 100 });
    expect(progress).toMatchObject({
      state: "active",
      elapsedDays: 182,
      daysLeft: 184,
      expectedAmount: 498_630_136,
      status: "on_track",
      gapAmount: 0,
      remainingAmount: 500_000_000,
      neededPerDay: 2_717_392, // ceil(5e8 / 184)
      progressBps: 5000,
      neededPcsPerDay: 11, // ceil(2_717_392 / 259_000)
    });
  });

  test("reached early: no more pace needed, progress can pass 100%", () => {
    const progress = computeGoalProgress(goal, "2027-09-01", 1_100_000_000, noRecentSales);
    expect(progress).toMatchObject({ state: "active", status: "reached", remainingAmount: 0, neededPerDay: null, progressBps: 11000 });
  });

  test("the last day still has a pace; after the end the result is final", () => {
    expect(computeGoalProgress(goal, "2027-10-31", 990_000_000, noRecentSales)).toMatchObject({
      state: "active",
      daysLeft: 1,
      expectedAmount: 1_000_000_000,
      neededPerDay: 10_000_000,
    });
    expect(computeGoalProgress(goal, "2027-11-01", 990_000_000, noRecentSales)).toMatchObject({
      state: "ended",
      elapsedDays: 365,
      daysLeft: 0,
      status: "behind",
      gapAmount: 10_000_000,
      neededPerDay: null,
      neededPerMonth: null,
      neededPcsPerDay: null,
    });
  });
});
