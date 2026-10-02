import { describe, expect, test } from "vitest";
import { normalizeColorHex } from "./color-hex";

describe("normalizeColorHex", () => {
  test("adds a leading # and uppercases a bare hex", () => {
    expect(normalizeColorHex("9caf88")).toBe("#9CAF88");
  });

  test("uppercases a hex that already has #", () => {
    expect(normalizeColorHex("#9caf88")).toBe("#9CAF88");
  });

  test("leaves an already-normalized hex unchanged", () => {
    expect(normalizeColorHex("#9CAF88")).toBe("#9CAF88");
  });

  test("rejects a short hex", () => {
    expect(normalizeColorHex("#9CA")).toBeNull();
  });

  test("rejects non-hex characters", () => {
    expect(normalizeColorHex("#GGGGGG")).toBeNull();
  });

  test("rejects an empty string", () => {
    expect(normalizeColorHex("")).toBeNull();
  });
});
