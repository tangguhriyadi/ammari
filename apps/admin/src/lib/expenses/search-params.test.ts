import { describe, expect, test } from "vitest";
import { expenseListHref, parseExpenseListParams } from "./search-params";

const NOW = new Date("2026-10-27T05:00:00Z");

describe("parseExpenseListParams", () => {
  test("defaults to this Jakarta month, nothing filtered", () => {
    expect(parseExpenseListParams({}, NOW)).toEqual({ month: "2026-10", group: undefined, category: undefined, showVoided: false, q: undefined });
  });

  test("keeps valid values and drops unknown, malformed or future ones", () => {
    expect(parseExpenseListParams({ month: "2026-09", group: "marketing", category: "ads_meta", voided: "1", q: "  BYA-1 " }, NOW)).toEqual({
      month: "2026-09",
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

describe("expenseListHref", () => {
  test("leaves defaults out", () => {
    expect(expenseListHref(parseExpenseListParams({}, NOW), NOW)).toBe("/ads-expenses");
    expect(expenseListHref({ month: "2026-09", group: "marketing", showVoided: true }, NOW)).toBe("/ads-expenses?month=2026-09&group=marketing&voided=1");
  });
});
