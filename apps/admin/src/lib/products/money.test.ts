import { describe, expect, test } from "vitest";
import { parseRupiah } from "./money";

describe("parseRupiah", () => {
  test("parses a plain dotted thousands amount", () => {
    expect(parseRupiah("269.000")).toBe(269_000);
  });

  test("parses with an 'Rp ' prefix and a space", () => {
    expect(parseRupiah("Rp 269.000")).toBe(269_000);
  });

  test("parses with an 'Rp' prefix and no space", () => {
    expect(parseRupiah("Rp269.000")).toBe(269_000);
  });

  test("parses a plain undotted amount", () => {
    expect(parseRupiah("269000")).toBe(269_000);
  });

  test("parses zero", () => {
    expect(parseRupiah("0")).toBe(0);
  });

  test("is case-insensitive on the 'Rp' prefix", () => {
    expect(parseRupiah("rp 229.000")).toBe(229_000);
  });

  test("rejects a decimal amount", () => {
    expect(parseRupiah("269,50")).toBeNull();
  });

  test("rejects a negative amount", () => {
    expect(parseRupiah("-1000")).toBeNull();
  });

  test("rejects non-numeric input", () => {
    expect(parseRupiah("abc")).toBeNull();
  });

  test("rejects an empty string", () => {
    expect(parseRupiah("")).toBeNull();
  });
});
