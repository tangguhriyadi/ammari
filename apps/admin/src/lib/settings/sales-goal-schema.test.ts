import { describe, expect, test } from "vitest";
import { SALES_GOAL_MESSAGES, salesGoalSchema } from "./sales-goal-schema";

const schema = salesGoalSchema("2026-10-24");

function firstError(input: { revenueTarget: string; startDate: string }) {
  const result = schema.safeParse(input);
  return result.success ? null : result.error.issues[0]?.message;
}

describe("salesGoalSchema", () => {
  test("accepts formatted rupiah and a calendar date", () => {
    expect(schema.parse({ revenueTarget: "Rp 1.000.000.000", startDate: "2026-11-01" })).toEqual({
      revenueTarget: 1_000_000_000,
      startDate: "2026-11-01",
    });
  });

  test("the amount is whole rupiah from 1 up to Rp 100 miliar", () => {
    expect(schema.parse({ revenueTarget: "1", startDate: "2026-11-01" }).revenueTarget).toBe(1);
    expect(schema.parse({ revenueTarget: "100.000.000.000", startDate: "2026-11-01" }).revenueTarget).toBe(100_000_000_000);
    expect(firstError({ revenueTarget: "0", startDate: "2026-11-01" })).toBe(SALES_GOAL_MESSAGES.amountRange);
    expect(firstError({ revenueTarget: "100.000.000.001", startDate: "2026-11-01" })).toBe(SALES_GOAL_MESSAGES.amountRange);
    expect(firstError({ revenueTarget: "9".repeat(30), startDate: "2026-11-01" })).toBe(SALES_GOAL_MESSAGES.amountRange);
  });

  test("rejects decimals, negatives, and text", () => {
    for (const revenueTarget of ["", "1,5", "-1000", "satu miliar"]) {
      expect(firstError({ revenueTarget, startDate: "2026-11-01" })).toBe(SALES_GOAL_MESSAGES.amountFormat);
    }
  });

  test("a missing or non-string field gets an Indonesian message, never zod's English default", () => {
    const result = schema.safeParse({ revenueTarget: 1000, startDate: undefined });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([SALES_GOAL_MESSAGES.invalidInput, SALES_GOAL_MESSAGES.invalidInput]);
  });

  test("the start date is a real date, not before 2020, at most one year after today", () => {
    expect(schema.parse({ revenueTarget: "1000", startDate: "2027-10-24" }).startDate).toBe("2027-10-24");
    expect(schema.parse({ revenueTarget: "1000", startDate: "2020-01-01" }).startDate).toBe("2020-01-01");
    expect(firstError({ revenueTarget: "1000", startDate: "2027-10-25" })).toBe(SALES_GOAL_MESSAGES.startDateTooLate);
    expect(firstError({ revenueTarget: "1000", startDate: "2019-12-31" })).toBe(SALES_GOAL_MESSAGES.startDateTooEarly);
    for (const startDate of ["", "2026-02-30", "01-11-2026", "kemarin"]) {
      expect(firstError({ revenueTarget: "1000", startDate })).toBe(SALES_GOAL_MESSAGES.startDateFormat);
    }
  });
});
