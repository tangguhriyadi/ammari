import { describe, expect, test } from "vitest";
import { suggestFabricCost } from "./fabric-cost";

describe("suggestFabricCost", () => {
  test("a fabric priced per yard is used directly", () => {
    expect(suggestFabricCost(10, { priceAmount: 85_000, priceUnit: "yard" })).toBe(850_000);
  });

  test("a fabric priced per meter is converted via the 0.9144 m/yard factor", () => {
    // pricePerYard = round(85_000 * 0.9144) = 77_724; 10 yards -> 777_240.
    expect(suggestFabricCost(10, { priceAmount: 85_000, priceUnit: "meter" })).toBe(777_240);
  });

  test("no yards entered yet -> null (nothing to prefill)", () => {
    expect(suggestFabricCost(null, { priceAmount: 85_000, priceUnit: "yard" })).toBeNull();
  });

  test("the fabric has no price on file -> null, not a crash", () => {
    expect(suggestFabricCost(10, { priceAmount: null, priceUnit: null })).toBeNull();
  });
});
