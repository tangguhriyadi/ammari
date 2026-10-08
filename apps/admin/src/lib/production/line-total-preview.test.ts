import { describe, expect, test } from "vitest";
import { previewLineTotal } from "./line-total-preview";

describe("previewLineTotal", () => {
  test("matches Postgres's round() on the classic float-error case: 0.35 * 10", () => {
    // Math.round(0.35 * 10) would give 3 (0.35 * 10 === 3.4999999999999996 in IEEE 754), but
    // Postgres's exact numeric arithmetic gives round(3.5) = 4. This must match the latter.
    expect(previewLineTotal(0.35, 10)).toBe(4);
  });

  test("a .x5 boundary rounds up (half away from zero), same as Postgres round()", () => {
    expect(previewLineTotal(1.5, 101)).toBe(152); // 151.5 -> 152
  });

  test("an evenly divisible total stays exact", () => {
    expect(previewLineTotal(2.5, 100)).toBe(250);
  });

  test("a whole-number quantity", () => {
    expect(previewLineTotal(3, 15_000)).toBe(45_000);
  });
});
