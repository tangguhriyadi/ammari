import { describe, expect, test } from "vitest";
import { CODE128_CODE_B, CODE128_CODE_C, CODE128_PATTERNS, CODE128_START_B, CODE128_START_C, CODE128_STOP, encodeCode128 } from "./code128";

// docs/plans/cart-checkout.md §15 Phase K, decision 49: the label's barcode. The table is checked
// against the properties every Code 128 symbol has; the encoder against hand-computed symbol
// values and an independent decoder below that reads the widths back. The printed label is also
// checked by hand with a phone scanner (runbook, K4).

/** Reads widths back to text the way a scanner does: 6 elements per symbol (7 for the stop),
 * pattern lookup, check symbol, then the set B / set C meaning of each value. */
function decode(widths: number[]): { text: string; values: number[] } {
  const lookup = new Map(CODE128_PATTERNS.map((pattern, value) => [pattern, value]));
  const values: number[] = [];
  let offset = 0;
  while (offset < widths.length) {
    const remaining = widths.length - offset;
    const take = remaining === 7 ? 7 : 6;
    const value = lookup.get(widths.slice(offset, offset + take).join(""));
    if (value === undefined) throw new Error(`no symbol at element ${offset}`);
    values.push(value);
    offset += take;
  }
  expect(values.at(-1)).toBe(CODE128_STOP);
  const data = values.slice(0, -2);
  const check = values.at(-2)!;
  const sum = data.reduce((total, value, position) => total + (position === 0 ? value : value * position), 0);
  expect(sum % 103).toBe(check);

  let set: "B" | "C" = data[0] === CODE128_START_C ? "C" : "B";
  expect([CODE128_START_B, CODE128_START_C]).toContain(data[0]);
  let text = "";
  for (const value of data.slice(1)) {
    if (set === "B" && value === CODE128_CODE_C) set = "C";
    else if (set === "C" && value === CODE128_CODE_B) set = "B";
    else if (set === "B") text += String.fromCharCode(value + 32);
    else text += String(value).padStart(2, "0");
  }
  return { text, values };
}

describe("Code 128 table", () => {
  test("107 symbols: 0 to 105 have 6 elements and 11 modules, the stop has 7 and 13", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    CODE128_PATTERNS.forEach((pattern, value) => {
      const widths = [...pattern].map(Number);
      expect(widths.every((width) => width >= 1 && width <= 4)).toBe(true);
      expect(widths).toHaveLength(value === CODE128_STOP ? 7 : 6);
      expect(widths.reduce((a, b) => a + b, 0)).toBe(value === CODE128_STOP ? 13 : 11);
    });
  });

  test("bars always add up to an even number of modules, spaces to an odd one (the symbology's parity)", () => {
    CODE128_PATTERNS.forEach((pattern) => {
      const widths = [...pattern].map(Number);
      const bars = widths.filter((_, index) => index % 2 === 0).reduce((a, b) => a + b, 0);
      const spaces = widths.filter((_, index) => index % 2 === 1).reduce((a, b) => a + b, 0);
      expect(bars % 2).toBe(0);
      expect(spaces % 2).toBe(1);
    });
  });

  test("every symbol is distinct", () => {
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
  });

  test("well-known symbols", () => {
    expect(CODE128_PATTERNS[0]).toBe("212222");
    expect(CODE128_PATTERNS[CODE128_CODE_C]).toBe("113141");
    expect(CODE128_PATTERNS[CODE128_CODE_B]).toBe("114131");
    expect(CODE128_PATTERNS[CODE128_START_B]).toBe("211214");
    expect(CODE128_PATTERNS[CODE128_START_C]).toBe("211232");
    expect(CODE128_PATTERNS[CODE128_STOP]).toBe("2331112");
  });
});

describe("encodeCode128", () => {
  test("letters and a short digit run stay in set B (hand-computed)", () => {
    // Start B 104, P 48, J 42, J 42, 1 17, 2 18, 3 19, C 35; check = (104 + 48 + 84 + 126 + 68 + 90 +
    // 114 + 245) mod 103 = 879 mod 103 = 55.
    expect(encodeCode128("PJJ123C").values).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55, 106]);
  });

  test("an even digit string is set C pairs (hand-computed)", () => {
    // Start C 105, 12, 34; check = (105 + 12 + 68) mod 103 = 82.
    expect(encodeCode128("1234").values).toEqual([105, 12, 34, 82, 106]);
  });

  test("an odd digit string: pairs in set C, the last digit in set B", () => {
    const { values } = encodeCode128("002345678901234");
    expect(values.slice(0, 10)).toEqual([105, 0, 23, 45, 67, 89, 1, 23, CODE128_CODE_B, 20]);
  });

  test("letters then a long digit run switch to set C (an odd run keeps its first digit in set B)", () => {
    const { values, widths } = encodeCode128("JP12345678901");
    // J P, then 11 digits: "1" in B, Code C, 23 45 67 89 01.
    expect(values.slice(0, 9)).toEqual([104, 42, 48, 17, CODE128_CODE_C, 23, 45, 67, 89]);
    expect(decode(widths).text).toBe("JP12345678901");
  });

  test("a digit run in the middle shorter than 6 stays in set B", () => {
    const { values } = encodeCode128("AB1234CD");
    expect(values).not.toContain(CODE128_CODE_C);
  });

  test.each([
    "0123082100003094",
    "E2E0000123456789",
    "JP1234567890",
    "002345678901234",
    "SCP-12345-ID",
    "TKP01-AB-12345678",
    "1",
    "12",
    "123",
    "A",
    "a b c",
    "~!@#$%^&*()_+{}|:<>?",
    "ID12345678901234567890X",
  ])("round-trips %j through an independent decoder", (text) => {
    const encoded = encodeCode128(text);
    expect(decode(encoded.widths).text).toBe(text);
    expect(encoded.widths).toHaveLength((encoded.values.length - 1) * 6 + 7);
    expect(encoded.modules).toBe((encoded.values.length - 1) * 11 + 13);
    // Starts and ends with a bar.
    expect(encoded.widths.length % 2).toBe(1);
  });

  test("set C makes a 16-digit waybill much narrower than set B would", () => {
    // 10 symbols (start, 8 pairs, check) + stop = 123 modules, against 18 x 11 + 13 = 211 in set B.
    expect(encodeCode128("0123082100003094").modules).toBe(123);
  });

  test.each(["", "x".repeat(81), "RESI\n1", "résumé", "\u0000"])("refuses %j", (text) => {
    expect(() => encodeCode128(text)).toThrow(RangeError);
  });
});
