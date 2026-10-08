import { describe, expect, test } from "vitest";
import { estimateFabricCost } from "./fabric-cost-estimate";

describe("estimateFabricCost", () => {
  test("yards × current average cost per yard, rounded", () => {
    expect(estimateFabricCost(10, { qty: 100, valueAmount: 850_000 })).toBe(85_000);
  });

  test("null when no yards entered yet", () => {
    expect(estimateFabricCost(null, { qty: 100, valueAmount: 850_000 })).toBeNull();
  });

  test("null when there's no stock to average over (no purchase history yet)", () => {
    expect(estimateFabricCost(10, { qty: 0, valueAmount: 0 })).toBeNull();
  });
});
