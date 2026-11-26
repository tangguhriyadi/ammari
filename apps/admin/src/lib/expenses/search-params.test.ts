import { describe, expect, test } from "vitest";
import { expenseListHref, expenseMenuPath, expenseReportHref, expenseSummaryHref, parseAdsTab, parseExpenseListParams, parseExpenseSummaryParams, parseExpensesTab } from "./search-params";
import { DEFAULT_EXPENSE_CATEGORY_INFOS } from "@/lib/expense-categories/default-catalog";

const NOW = new Date("2026-10-27T05:00:00Z");
const CATEGORIES = DEFAULT_EXPENSE_CATEGORY_INFOS;

describe("parseExpenseListParams", () => {
  test("defaults to this Jakarta month, nothing filtered, on the given menu", () => {
    expect(parseExpenseListParams({}, CATEGORIES, "operational", NOW)).toEqual({
      month: "2026-10",
      range: undefined,
      group: "operational",
      category: undefined,
      channelId: undefined,
      showVoided: false,
      q: undefined,
    });
  });

  test("keeps valid values and drops unknown, malformed or future ones", () => {
    expect(parseExpenseListParams({ month: "2026-09", category: "ads_meta", channel: "web", voided: "1", q: "  BYA-1 " }, CATEGORIES, "marketing", NOW)).toEqual({
      month: "2026-09",
      range: undefined,
      group: "marketing",
      category: "ads_meta",
      channelId: "web",
      showVoided: true,
      q: "BYA-1",
    });
    expect(parseExpenseListParams({ month: "2026-11" }, CATEGORIES, "operational", NOW).month).toBe("2026-10");
    expect(parseExpenseListParams({ month: "2026-13" }, CATEGORIES, "operational", NOW).month).toBe("2026-10");
    expect(parseExpenseListParams({ category: "gift", channel: "fax" }, CATEGORIES, "marketing", NOW)).toMatchObject({ category: undefined, channelId: undefined });
  });

  test("kind-scoped: a category of the other menu is dropped (Endorse/KOL belongs to Iklan, D7)", () => {
    expect(parseExpenseListParams({ category: "ads_meta" }, CATEGORIES, "operational", NOW).category).toBeUndefined();
    expect(parseExpenseListParams({ category: "endorsement" }, CATEGORIES, "operational", NOW).category).toBeUndefined();
    expect(parseExpenseListParams({ category: "endorsement" }, CATEGORIES, "marketing", NOW).category).toBe("endorsement");
    expect(parseExpenseListParams({ category: "salary" }, CATEGORIES, "marketing", NOW).category).toBeUndefined();
    expect(parseExpenseListParams({ category: "salary" }, CATEGORIES, "operational", NOW).category).toBe("salary");
  });

  test("a channel only exists on Iklan", () => {
    expect(parseExpenseListParams({ channel: "shopee" }, CATEGORIES, "operational", NOW).channelId).toBeUndefined();
    expect(parseExpenseListParams({ channel: "shopee" }, CATEGORIES, "marketing", NOW).channelId).toBe("shopee");
  });
});

describe("parseExpenseListParams: a from/to window (the Gaji/Sewa reminder link)", () => {
  test("a valid window is kept, across a month end", () => {
    expect(parseExpenseListParams({ from: "2026-09-06", to: "2026-10-05" }, CATEGORIES, "operational", NOW).range).toEqual({ from: "2026-09-06", to: "2026-10-05" });
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
      expect(parseExpenseListParams(bad, CATEGORIES, "operational", NOW).range).toBeUndefined();
    }
  });
});

describe("expenseListHref", () => {
  test("the menu of the group, defaults left out", () => {
    expect(expenseListHref(parseExpenseListParams({}, CATEGORIES, "operational", NOW), NOW)).toBe("/expenses");
    expect(expenseListHref(parseExpenseListParams({}, CATEGORIES, "marketing", NOW), NOW)).toBe("/ads");
    expect(expenseListHref({ month: "2026-09", group: "marketing", channelId: "tiktok", showVoided: true }, NOW)).toBe("/ads?month=2026-09&channel=tiktok&voided=1");
    // A window replaces the month; a channel never goes on Biaya.
    expect(expenseListHref({ month: "2026-09", range: { from: "2026-09-06", to: "2026-10-05" }, group: "operational", channelId: "tiktok", showVoided: false }, NOW)).toBe(
      "/expenses?from=2026-09-06&to=2026-10-05",
    );
    expect(expenseListHref({ month: "2026-10", group: "operational", category: "salary", q: "BYA-1", showVoided: false }, NOW)).toBe("/expenses?category=salary&q=BYA-1");
  });

  test("expenseMenuPath", () => {
    expect(expenseMenuPath("marketing")).toBe("/ads");
    expect(expenseMenuPath("operational")).toBe("/expenses");
  });
});

describe("parseAdsTab / parseExpensesTab", () => {
  test("Iklan: Catatan iklan unless ?tab=roas", () => {
    expect(parseAdsTab({})).toBe("list");
    expect(parseAdsTab({ tab: "roas" })).toBe("roas");
    expect(parseAdsTab({ tab: ["roas", "x"] })).toBe("roas");
    expect(parseAdsTab({ tab: "pnl" })).toBe("list");
    expect(parseAdsTab({ tab: "ringkasan" })).toBe("list");
  });

  test("Biaya: Biaya operasional unless ?tab=pnl", () => {
    expect(parseExpensesTab({})).toBe("list");
    expect(parseExpensesTab({ tab: "pnl" })).toBe("pnl");
    expect(parseExpensesTab({ tab: "roas" })).toBe("list");
    expect(parseExpensesTab({ tab: "ringkasan" })).toBe("list");
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
  test("Laba rugi on Biaya by default; only the params the period needs", () => {
    expect(expenseSummaryHref({ period: "this_month" })).toBe("/expenses?tab=pnl");
    expect(expenseSummaryHref({ period: "last_month" })).toBe("/expenses?tab=pnl&period=last_month");
    expect(expenseSummaryHref({ period: "month", fromMonth: "2026-02" })).toBe("/expenses?tab=pnl&period=month&month=2026-02");
    expect(expenseSummaryHref({ period: "range", fromMonth: "2026-01", toMonth: "2026-03" })).toBe("/expenses?tab=pnl&period=range&from=2026-01&to=2026-03");
    expect(expenseSummaryHref({ period: "month" })).toBe("/expenses?tab=pnl&period=month");
  });

  test("ROAS on Iklan", () => {
    expect(expenseSummaryHref({ period: "this_month" }, "roas")).toBe("/ads?tab=roas");
    expect(expenseSummaryHref({ period: "month", fromMonth: "2026-02" }, "roas")).toBe("/ads?tab=roas&period=month&month=2026-02");
  });
});

describe("expenseReportHref (session S6, on Biaya since S5)", () => {
  test("the shown months as an explicit month or range", () => {
    expect(expenseReportHref({ period: "this_month", fromMonth: "2026-10", toMonth: "2026-10" }, "pdf")).toBe("/expenses/report?format=pdf&period=month&month=2026-10");
    expect(expenseReportHref({ period: "range", fromMonth: "2026-01", toMonth: "2026-03" }, "xlsx")).toBe("/expenses/report?format=xlsx&period=range&from=2026-01&to=2026-03");
  });
});
