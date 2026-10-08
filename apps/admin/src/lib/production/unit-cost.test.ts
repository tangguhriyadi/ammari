import { describe, expect, test } from "vitest";
import { calculateUnitCost } from "./unit-cost";

describe("calculateUnitCost", () => {
  test("rounds up, not to nearest", () => {
    expect(calculateUnitCost(1_000_000, 3)).toBe(333_334); // 333333.33... -> 333334
  });

  test("evenly divisible cost stays exact", () => {
    expect(calculateUnitCost(900_000, 3)).toBe(300_000);
  });

  test("a single piece costs the whole batch", () => {
    expect(calculateUnitCost(500_000, 1)).toBe(500_000);
  });
});
