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

  test("expands 3-digit shorthand by doubling each digit", () => {
    expect(normalizeColorHex("#fa3")).toBe("#FFAA33");
  });

  test("expands shorthand black", () => {
    expect(normalizeColorHex("#000")).toBe("#000000");
  });

  test("expands shorthand without a leading #", () => {
    expect(normalizeColorHex("fa3")).toBe("#FFAA33");
  });

  test("rejects a 4-digit hex (neither shorthand nor full)", () => {
    expect(normalizeColorHex("#9CA1")).toBeNull();
  });

  test("rejects a 5-digit hex", () => {
    expect(normalizeColorHex("#9CA12")).toBeNull();
  });

  test("rejects non-hex characters", () => {
    expect(normalizeColorHex("#GGGGGG")).toBeNull();
  });

  test("rejects an empty string", () => {
    expect(normalizeColorHex("")).toBeNull();
  });
});
