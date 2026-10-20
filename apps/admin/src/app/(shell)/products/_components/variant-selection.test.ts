import { describe, expect, test } from "vitest";
import { buildNewVariantSelections } from "./variant-selection";

const existing = new Map<string, Set<string>>([["taupe", new Set(["S", "M", "L"])]]);

describe("buildNewVariantSelections", () => {
  test("keeps only the sizes a color doesn't have yet", () => {
    expect(buildNewVariantSelections(["taupe"], ["M", "XL"], existing)).toEqual([{ fabricColorId: "taupe", sizes: ["XL"] }]);
  });

  test("returns nothing when every selected size already exists (button stays disabled)", () => {
    expect(buildNewVariantSelections(["taupe"], ["S", "M"], existing)).toEqual([]);
  });

  test("returns nothing without a size or without a color", () => {
    expect(buildNewVariantSelections(["taupe"], [], existing)).toEqual([]);
    expect(buildNewVariantSelections([], ["XL"], existing)).toEqual([]);
  });

  test("drops a color with nothing new but keeps the others in the same submission", () => {
    expect(buildNewVariantSelections(["taupe", "sage"], ["S"], existing)).toEqual([{ fabricColorId: "sage", sizes: ["S"] }]);
  });

  test("a brand-new color gets every selected size, ALLSIZE included", () => {
    expect(buildNewVariantSelections(["sage"], ["ALLSIZE"], existing)).toEqual([{ fabricColorId: "sage", sizes: ["ALLSIZE"] }]);
  });
});
