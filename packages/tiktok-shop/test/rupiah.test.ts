import { describe, expect, test } from "vitest";
import { TikTokMoneyFormatError, parseRupiah } from "../src/rupiah";

describe("parseRupiah (strict whole rupiah, Q6)", () => {
  test.each([
    ["125000", 125000],
    ["0", 0],
    ["1", 1],
    ["9007199254740991", Number.MAX_SAFE_INTEGER],
  ])("accepts %j", (value, expected) => {
    expect(parseRupiah(value)).toBe(expected);
  });

  test("refuses every JSON number, even an integer: its spelling (1e5, 125000.00) is already lost", () => {
    expect(() => parseRupiah(125000)).toThrow(TikTokMoneyFormatError);
    expect(() => parseRupiah(JSON.parse('{"a":1e5}').a)).toThrow(TikTokMoneyFormatError);
    expect(() => parseRupiah(JSON.parse('{"a":125000.00}').a)).toThrow(TikTokMoneyFormatError);
  });

  test.each([
    "125000.50",
    "125000.00",
    "125000.",
    ".5",
    "1e5",
    "1E5",
    "",
    " 1",
    "1 ",
    "\t1",
    "+1",
    "01",
    "-0",
    "1,000",
    "1.000",
    "1_000",
    "0x10",
    "Infinity",
    "NaN",
    "Rp125000",
    "１２３", // full-width digits
    "9007199254740992", // beyond MAX_SAFE_INTEGER
  ])("refuses %j and never rounds", (value) => {
    expect(() => parseRupiah(value)).toThrow(TikTokMoneyFormatError);
  });

  test.each([125000.5, Number.NaN, Number.POSITIVE_INFINITY, -0, 2 ** 53, null, undefined, true, {}, [], 125000n])("refuses non-string %s", (value) => {
    expect(() => parseRupiah(value)).toThrow(TikTokMoneyFormatError);
  });

  test("a negative is refused unless allowed", () => {
    expect(() => parseRupiah("-5000")).toThrow(TikTokMoneyFormatError);
    expect(parseRupiah("-5000", { allowNegative: true })).toBe(-5000);
    expect(() => parseRupiah(-5000, { allowNegative: true })).toThrow(TikTokMoneyFormatError);
    expect(() => parseRupiah("-5000.5", { allowNegative: true })).toThrow(TikTokMoneyFormatError);
    expect(() => parseRupiah("--5", { allowNegative: true })).toThrow(TikTokMoneyFormatError);
  });

  test("the error names the field, never the value", () => {
    try {
      parseRupiah("125000.50", { field: "payment.sub_total" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TikTokMoneyFormatError);
      expect((error as TikTokMoneyFormatError).field).toBe("payment.sub_total");
      expect((error as Error).message).toContain("payment.sub_total");
      expect((error as Error).message).not.toContain("125000");
    }
  });
});
