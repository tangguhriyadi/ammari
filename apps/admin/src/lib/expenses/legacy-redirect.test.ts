import { describe, expect, test } from "vitest";
import type { ExpenseCategoryInfo } from "@/lib/expense-categories/catalog";
import { DEFAULT_EXPENSE_CATEGORY_INFOS } from "@/lib/expense-categories/default-catalog";
import { legacyAdsExpensesHref, legacyExpenseNoQuery, legacyReportHref } from "./legacy-redirect";

// docs/plans/expense-master-data.md §3.8: every row of the redirect table for the old
// "Iklan & Biaya" URLs.

const CATEGORIES: readonly Pick<ExpenseCategoryInfo, "code" | "kind">[] = [
  ...DEFAULT_EXPENSE_CATEGORY_INFOS,
  // Owner-made categories: one ad (counted on Iklan) and one operating.
  { code: "ads_google", kind: "ad" },
  { code: "langganan", kind: "operating" },
];

type Kind = "ad" | "endorsement" | "operating";
const href = (raw: Record<string, string | string[] | undefined>, expenseKind: Kind | null = null, month = "2026-02") =>
  legacyAdsExpensesHref(raw, { categories: CATEGORIES, expense: expenseKind ? { kind: expenseKind, month } : null });

describe("legacyAdsExpensesHref", () => {
  test("?tab=ringkasan goes to Biaya, Laba rugi, with the period params carried over", () => {
    expect(href({ tab: "ringkasan" })).toBe("/expenses?tab=pnl");
    expect(href({ tab: "ringkasan", period: "month", month: "2026-02" })).toBe("/expenses?tab=pnl&period=month&month=2026-02");
    expect(href({ tab: "ringkasan", period: "range", from: "2026-01", to: "2026-03" })).toBe("/expenses?tab=pnl&period=range&from=2026-01&to=2026-03");
    expect(href({ tab: "ringkasan", period: "last_month" })).toBe("/expenses?tab=pnl&period=last_month");
    // List-only params are not carried to the summary.
    expect(href({ tab: "ringkasan", q: "BYA-1", group: "marketing", category: "ads_meta" })).toBe("/expenses?tab=pnl");
  });

  test("?group=marketing goes to Iklan, ?group=operational to Biaya; group itself is dropped", () => {
    expect(href({ group: "marketing" })).toBe("/ads");
    expect(href({ group: "marketing", month: "2026-09", voided: "1", q: "promo", page: "2" })).toBe("/ads?month=2026-09&voided=1&q=promo&page=2");
    expect(href({ group: "operational" })).toBe("/expenses");
    // The monthly-bill reminder's old link.
    expect(href({ from: "2026-09-06", to: "2026-10-05", group: "operational" })).toBe("/expenses?from=2026-09-06&to=2026-10-05");
  });

  test("a category picks the menu by its kind (owner-made ones too); Endorse/KOL is on Iklan (D7)", () => {
    expect(href({ category: "ads_meta" })).toBe("/ads?category=ads_meta");
    expect(href({ category: "endorsement" })).toBe("/ads?category=endorsement");
    expect(href({ category: "ads_google", month: "2026-08" })).toBe("/ads?month=2026-08&category=ads_google");
    expect(href({ category: "salary" })).toBe("/expenses?category=salary");
    expect(href({ category: "langganan" })).toBe("/expenses?category=langganan");
  });

  test("group wins over a category of the other group, which is dropped (as the old page dropped it)", () => {
    expect(href({ group: "operational", category: "ads_meta" })).toBe("/expenses");
    expect(href({ group: "marketing", category: "salary" })).toBe("/ads");
    expect(href({ group: "marketing", category: "ads_tiktok" })).toBe("/ads?category=ads_tiktok");
  });

  test("an unknown category or group falls back to Biaya without it", () => {
    expect(href({ category: "hadiah" })).toBe("/expenses");
    expect(href({ group: "x" })).toBe("/expenses");
  });

  test("?q=BYA-... (activity log) goes to the menu of that expense's kind, on its month; unknown goes to Biaya", () => {
    expect(href({ q: "BYA-202602-001" }, "ad")).toBe("/ads?month=2026-02&q=BYA-202602-001");
    expect(href({ q: "BYA-202602-002" }, "endorsement")).toBe("/ads?month=2026-02&q=BYA-202602-002");
    expect(href({ q: "BYA-202610-003" }, "operating", "2026-10")).toBe("/expenses?month=2026-10&q=BYA-202610-003");
    expect(href({ q: "BYA-209901-999" }, null)).toBe("/expenses?q=BYA-209901-999");
    // A month or window in the link itself wins over the expense's month.
    expect(href({ q: "BYA-202602-001", month: "2026-03" }, "ad")).toBe("/ads?month=2026-03&q=BYA-202602-001");
    expect(href({ q: "BYA-202602-001", from: "2026-01-06", to: "2026-02-05" }, "ad")).toBe("/ads?from=2026-01-06&to=2026-02-05&q=BYA-202602-001");
  });

  test("anything else goes to Biaya; empty values are dropped", () => {
    expect(href({})).toBe("/expenses");
    expect(href({ tab: "pengeluaran", month: "", q: "" })).toBe("/expenses");
    expect(href({ month: "2026-07", perPage: "50" })).toBe("/expenses?month=2026-07&perPage=50");
    // A repeated key takes its first value, as the pages do.
    expect(href({ group: ["marketing", "operational"] })).toBe("/ads");
  });
});

describe("legacyExpenseNoQuery", () => {
  test("only an expense number on the list without a group is looked up", () => {
    expect(legacyExpenseNoQuery({ q: "BYA-202610-001" })).toBe("BYA-202610-001");
    expect(legacyExpenseNoQuery({ q: " bya-202610-001 " })).toBe("BYA-202610-001");
    expect(legacyExpenseNoQuery({ q: "promo" })).toBeUndefined();
    expect(legacyExpenseNoQuery({ q: "BYA-%" })).toBeUndefined();
    expect(legacyExpenseNoQuery({})).toBeUndefined();
    expect(legacyExpenseNoQuery({ q: "BYA-202610-001", group: "marketing" })).toBeUndefined();
    expect(legacyExpenseNoQuery({ q: "BYA-202610-001", tab: "ringkasan" })).toBeUndefined();
  });
});

describe("legacyReportHref", () => {
  test("the query string unchanged", () => {
    expect(legacyReportHref("?format=pdf&period=month&month=2026-02")).toBe("/expenses/report?format=pdf&period=month&month=2026-02");
    expect(legacyReportHref("")).toBe("/expenses/report");
  });
});
