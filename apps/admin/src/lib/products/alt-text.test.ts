import { describe, expect, test } from "vitest";
import { defaultImageAltText } from "./alt-text";

describe("defaultImageAltText", () => {
  test("a color photo reads '<product> warna <color>'", () => {
    expect(defaultImageAltText("Haura Dress", "Taupe")).toBe("Haura Dress warna Taupe");
  });

  test("a general photo is just the product name", () => {
    expect(defaultImageAltText("Haura Dress", null)).toBe("Haura Dress");
  });
});
