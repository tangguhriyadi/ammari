import { describe, expect, test } from "vitest";
import { parseDecimalQuantity } from "./decimal-quantity";

describe("parseDecimalQuantity", () => {
  test("parses a whole number", () => {
    expect(parseDecimalQuantity("12")).toBe(12);
  });

  test("parses up to 2 decimal places", () => {
    expect(parseDecimalQuantity("12.5")).toBe(12.5);
    expect(parseDecimalQuantity("0.35")).toBe(0.35);
  });

  test("rejects more than 2 decimal places", () => {
    expect(parseDecimalQuantity("12.555")).toBeNull();
  });

  test("rejects a comma decimal separator", () => {
    expect(parseDecimalQuantity("12,5")).toBeNull();
  });

  test("rejects zero and negative values", () => {
    expect(parseDecimalQuantity("0")).toBeNull();
    expect(parseDecimalQuantity("-1")).toBeNull();
  });

  test("rejects blank/garbage input", () => {
    expect(parseDecimalQuantity("")).toBeNull();
    expect(parseDecimalQuantity("abc")).toBeNull();
  });
});
