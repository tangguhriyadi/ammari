import { describe, expect, test } from "vitest";
import { expenseListHref, expenseSummaryHref, parseExpenseListParams, parseExpenseSummaryParams, parseExpenseTab } from "./search-params";

const NOW = new Date("2026-10-27T05:00:00Z");

describe("parseExpenseListParams", () => {
  test("defaults to this Jakarta month, nothing filtered", () => {
    expect(parseExpenseListParams({}, NOW)).toEqual({ month: "2026-10", range: undefined, group: undefined, category: undefined, showVoided: false, q: undefined });
  });

  test("keeps valid values and drops unknown, malformed or future ones", () => {
    expect(parseExpenseListParams({ month: "2026-09", group: "marketing", category: "ads_meta", voided: "1", q: "  BYA-1 " }, NOW)).toEqual({
      month: "2026-09",
      range: undefined,
      group: "marketing",
      category: "ads_meta",
      showVoided: true,
      q: "BYA-1",
    });
    expect(parseExpenseListParams({ month: "2026-11" }, NOW).month).toBe("2026-10");
    expect(parseExpenseListParams({ month: "2026-13" }, NOW).month).toBe("2026-10");
    expect(parseExpenseListParams({ group: "x", category: "gift" }, NOW)).toMatchObject({ group: undefined, category: undefined });
  });

  test("a category outside the chosen group is dropped", () => {
    expect(parseExpenseListParams({ group: "operational", category: "ads_meta" }, NOW)).toMatchObject({ group: "operational", category: undefined });
  });
});

describe("parseExpenseListParams: a from/to window (the Gaji/Sewa reminder link)", () => {
  test("a valid window is kept, across a month end", () => {
    expect(parseExpenseListParams({ from: "2026-09-06", to: "2026-10-05" }, NOW).range).toEqual({ from: "2026-09-06", to: "2026-10-05" });
  });

  test("reversed, future, malformed, too long, too early or half a window is no window", () => {
    for (const bad of [
      { from: "2026-10-05", to: "2026-09-06" },
      { from: "2026-10-01", to: "2026-10-28" },
      { from: "2026-02-30", to: "2026-03-05" },
      { from: "2025-01-01", to: "2026-10-01" },
      { from: "0050-01-01", to: "0050-01-05" },
      { from: "2026-09-06" },
    ]) {
      expect(parseExpenseListParams(bad, NOW).range).toBeUndefined();
    }
  });
});

describe("expenseListHref", () => {
  test("leaves defaults out", () => {
    expect(expenseListHref(parseExpenseListParams({}, NOW), NOW)).toBe("/ads-expenses");
    expect(expenseListHref({ month: "2026-09", group: "marketing", showVoided: true }, NOW)).toBe("/ads-expenses?month=2026-09&group=marketing&voided=1");
    // A window replaces the month.
    expect(expenseListHref({ month: "2026-09", range: { from: "2026-09-06", to: "2026-10-05" }, group: "operational", showVoided: false }, NOW)).toBe(
      "/ads-expenses?from=2026-09-06&to=2026-10-05&group=operational",
    );
  });
});

describe("parseExpenseTab", () => {
  test("Pengeluaran unless ?tab=ringkasan", () => {
    expect(parseExpenseTab({})).toBe("expenses");
    expect(parseExpenseTab({ tab: "ringkasan" })).toBe("summary");
    expect(parseExpenseTab({ tab: ["ringkasan", "x"] })).toBe("summary");
    expect(parseExpenseTab({ tab: "other" })).toBe("expenses");
  });
});

describe("parseExpenseSummaryParams (plan §4.2: whole months only)", () => {
  test("default: this month up to today (Jakarta)", () => {
    expect(parseExpenseSummaryParams({}, NOW)).toEqual({
      period: "this_month",
      fromMonth: "2026-10",
      toMonth: "2026-10",
      range: { from: "2026-10-01", to: "2026-10-27" },
      invalid: false,
    });
  });

  test("last month is the whole previous month, across a year end too", () => {
    expect(parseExpenseSummaryParams({ period: "last_month" }, NOW)).toMatchObject({ fromMonth: "2026-09", toMonth: "2026-09", range: { from: "2026-09-01", to: "2026-09-30" } });
    expect(parseExpenseSummaryParams({ period: "last_month" }, new Date("2027-01-10T05:00:00Z")).range).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  test("a chosen month: whole month, this month only up to today; future or malformed falls back and says so", () => {
    expect(parseExpenseSummaryParams({ period: "month", month: "2026-02" }, NOW)).toMatchObject({ period: "month", range: { from: "2026-02-01", to: "2026-02-28" }, invalid: false });
    expect(parseExpenseSummaryParams({ period: "month", month: "2026-10" }, NOW).range).toEqual({ from: "2026-10-01", to: "2026-10-27" });
    // The form was only opened: this month, no complaint.
    expect(parseExpenseSummaryParams({ period: "month" }, NOW)).toMatchObject({ period: "month", fromMonth: "2026-10", invalid: false });
    for (const month of ["2026-11", "2026-13", "abc", "0050-03", "0000-01", "1999-12"]) {
      expect(parseExpenseSummaryParams({ period: "month", month }, NOW)).toMatchObject({ period: "month", fromMonth: "2026-10", toMonth: "2026-10", invalid: true });
    }
  });

  test("a month range: at most 12 months, in order, not past this month", () => {
    expect(parseExpenseSummaryParams({ period: "range", from: "2025-11", to: "2026-10" }, NOW)).toMatchObject({
      period: "range",
      fromMonth: "2025-11",
      toMonth: "2026-10",
      range: { from: "2025-11-01", to: "2026-10-27" },
      invalid: false,
    });
    expect(parseExpenseSummaryParams({ period: "range", from: "2026-01", to: "2026-03" }, NOW).range).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    for (const bad of [
      { from: "2025-10", to: "2026-10" }, // 13 months
      { from: "2026-05", to: "2026-04" },
      { from: "2026-09", to: "2026-11" },
      { from: "2026-09" },
      { from: "0001-01", to: "0001-12" },
    ]) {
      expect(parseExpenseSummaryParams({ period: "range", ...bad }, NOW)).toMatchObject({ period: "range", fromMonth: "2026-10", toMonth: "2026-10", invalid: true });
    }
  });

  test("unknown period is the default", () => {
    expect(parseExpenseSummaryParams({ period: "7d" }, NOW).period).toBe("this_month");
  });
});

describe("expenseSummaryHref", () => {
  test("only the params the period needs", () => {
    expect(expenseSummaryHref({ period: "this_month" })).toBe("/ads-expenses?tab=ringkasan");
    expect(expenseSummaryHref({ period: "last_month" })).toBe("/ads-expenses?tab=ringkasan&period=last_month");
    expect(expenseSummaryHref({ period: "month", fromMonth: "2026-02" })).toBe("/ads-expenses?tab=ringkasan&period=month&month=2026-02");
    expect(expenseSummaryHref({ period: "range", fromMonth: "2026-01", toMonth: "2026-03" })).toBe("/ads-expenses?tab=ringkasan&period=range&from=2026-01&to=2026-03");
    expect(expenseSummaryHref({ period: "month" })).toBe("/ads-expenses?tab=ringkasan&period=month");
  });
});
