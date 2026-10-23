import { describe, expect, test } from "vitest";
import {
  basePriceBreaksDiscountMessage,
  checkDiscountRules,
  DISCOUNT_ENDED_MESSAGE,
  DISCOUNT_PERCENT_NOT_ROUNDABLE_MESSAGE,
  DISCOUNT_PERCENT_RANGE_MESSAGE,
  DISCOUNT_PRICE_REQUIRED_MESSAGE,
  DISCOUNT_WINDOW_MESSAGE,
  formatPercentTenths,
  jakartaLocalToUtc,
  parseDiscountPercent,
  percentTextForPrice,
  priceForPercentText,
  utcToJakartaLocal,
} from "./discount";

const NOW = new Date("2026-10-23T05:00:00Z");

describe("WIB datetime conversion", () => {
  test("a datetime-local value is read as Asia/Jakarta (UTC+7)", () => {
    expect(jakartaLocalToUtc("2026-11-01T00:00")?.toISOString()).toBe("2026-10-31T17:00:00.000Z");
    expect(jakartaLocalToUtc("2026-11-01T10:30")?.toISOString()).toBe("2026-11-01T03:30:00.000Z");
  });

  test("seconds are dropped (minute precision)", () => {
    expect(jakartaLocalToUtc("2026-11-01T10:30:45")?.toISOString()).toBe("2026-11-01T03:30:00.000Z");
  });

  test("round-trips back to the same WIB value", () => {
    const utc = jakartaLocalToUtc("2026-12-31T23:59");
    expect(utc).not.toBeNull();
    expect(utcToJakartaLocal(utc!)).toBe("2026-12-31T23:59");
    expect(utcToJakartaLocal(new Date("2026-10-31T17:00:00Z"))).toBe("2026-11-01T00:00");
  });

  test("rejects anything that is not a real date and time, without throwing", () => {
    for (const value of ["", "2026-11-01", "2026-02-30T10:00", "2026-13-01T10:00", "2026-11-01T24:00", "besok", "2026-11-01T10:60"]) {
      expect(jakartaLocalToUtc(value)).toBeNull();
    }
  });
});

describe("parseDiscountPercent", () => {
  test("accepts whole numbers 1..99, with or without a % sign", () => {
    expect(parseDiscountPercent("20")).toBe(20);
    expect(parseDiscountPercent(" 1 ")).toBe(1);
    expect(parseDiscountPercent("99%")).toBe(99);
  });

  test("rejects decimals, 0, 100 and text", () => {
    for (const value of ["", "0", "100", "20,5", "20.5", "-5", "abc", "1e1"]) expect(parseDiscountPercent(value)).toBeNull();
  });
});

describe("linked inputs", () => {
  test("typing a Rp price shows the real percent floored to one decimal (plan §3.1: 350.000 -> 279.000 is 20,2)", () => {
    expect(percentTextForPrice(350_000, "279.000")).toBe("20,2");
    expect(percentTextForPrice(350_000, "Rp 280.000")).toBe("20");
  });

  test("a price that is empty, unreadable or not below the base shows no percent, and never throws", () => {
    for (const text of ["", "abc", "279,5", "350.000", "400.000", "-1"]) expect(percentTextForPrice(350_000, text)).toBe("");
    expect(percentTextForPrice(0, "1")).toBe("");
  });

  test("typing a percent fills the price rounded down to Rp1.000 (plan §3.1 table)", () => {
    expect(priceForPercentText(350_000, "20")).toEqual({ ok: true, priceText: "280.000" });
    expect(priceForPercentText(349_000, "20")).toEqual({ ok: true, priceText: "279.000" });
    expect(priceForPercentText(399_000, "15")).toEqual({ ok: true, priceText: "339.000" });
    expect(priceForPercentText(189_000, "35")).toEqual({ ok: true, priceText: "122.000" });
    expect(priceForPercentText(99_000, "20")).toEqual({ ok: true, priceText: "79.000" });
  });

  test("a percent that cannot round to Rp1.000 asks for the Rp price instead", () => {
    expect(priceForPercentText(50_500, "1")).toEqual({ ok: false, message: DISCOUNT_PERCENT_NOT_ROUNDABLE_MESSAGE });
  });

  test("an out-of-range or malformed percent gives the range message, never a throw", () => {
    for (const text of ["0", "100", "12,5", "x"]) expect(priceForPercentText(350_000, text)).toEqual({ ok: false, message: DISCOUNT_PERCENT_RANGE_MESSAGE });
    expect(priceForPercentText(0, "20")).toEqual({ ok: false, message: DISCOUNT_PERCENT_NOT_ROUNDABLE_MESSAGE });
  });

  test("an empty percent field is not an error", () => {
    expect(priceForPercentText(350_000, "  ")).toBeNull();
  });

  test("formatPercentTenths uses a comma and drops a trailing ,0", () => {
    expect(formatPercentTenths(202)).toBe("20,2");
    expect(formatPercentTenths(200)).toBe("20");
    expect(formatPercentTenths(5)).toBe("0,5");
  });
});

describe("checkDiscountRules (plan §3.2)", () => {
  const valid = { basePrice: 350_000, discountPriceAmount: 279_000, discountEnabled: true, discountStartsAt: null, discountEndsAt: null };

  test("a valid discount passes", () => {
    expect(checkDiscountRules(valid, NOW)).toBeNull();
  });

  test("sale price rules map to the plan's messages", () => {
    expect(checkDiscountRules({ ...valid, discountPriceAmount: 0 }, NOW)).toEqual({ field: "discountPriceAmount", message: "Harga setelah diskon harus lebih dari Rp 0." });
    expect(checkDiscountRules({ ...valid, discountPriceAmount: 350_000 }, NOW)).toEqual({
      field: "discountPriceAmount",
      message: "Harga setelah diskon harus lebih kecil dari harga normal.",
    });
    expect(checkDiscountRules({ ...valid, discountPriceAmount: 348_000 }, NOW)).toEqual({ field: "discountPriceAmount", message: "Diskon minimal 1%." });
  });

  test("toggle on requires a price; toggle off without a price is fine", () => {
    expect(checkDiscountRules({ ...valid, discountPriceAmount: null }, NOW)).toEqual({ field: "discountPriceAmount", message: DISCOUNT_PRICE_REQUIRED_MESSAGE });
    expect(checkDiscountRules({ ...valid, discountPriceAmount: null, discountEnabled: false }, NOW)).toBeNull();
  });

  test("end must be after start", () => {
    const at = new Date("2026-11-01T00:00:00Z");
    expect(checkDiscountRules({ ...valid, discountStartsAt: at, discountEndsAt: at }, NOW)).toEqual({ field: "discountEndsAt", message: DISCOUNT_WINDOW_MESSAGE });
  });

  test("an end in the past is refused while the toggle is on, allowed while off", () => {
    const past = new Date("2026-10-23T04:59:00Z");
    expect(checkDiscountRules({ ...valid, discountEndsAt: past }, NOW)).toEqual({ field: "discountEndsAt", message: DISCOUNT_ENDED_MESSAGE });
    expect(checkDiscountRules({ ...valid, discountEndsAt: NOW }, NOW)).toEqual({ field: "discountEndsAt", message: DISCOUNT_ENDED_MESSAGE });
    expect(checkDiscountRules({ ...valid, discountEnabled: false, discountEndsAt: past }, NOW)).toBeNull();
  });

  test("a start in the past is allowed (already started)", () => {
    expect(checkDiscountRules({ ...valid, discountStartsAt: new Date("2026-01-01T00:00:00Z") }, NOW)).toBeNull();
  });
});

test("the base price message names the stored sale price (plan §3.2)", () => {
  expect(basePriceBreaksDiscountMessage(279_000)).toBe(
    "Harga normal harus lebih besar dari harga diskon (Rp 279.000) dan diskon minimal 1%. Ubah atau hapus diskon dulu.",
  );
});
