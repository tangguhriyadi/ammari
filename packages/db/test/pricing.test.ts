import { describe, expect, test } from "vitest";
import {
  discountPercentOff,
  discountPercentTenths,
  discountStatus,
  isDiscountActive,
  resolveUnitPrice,
  salePriceFromPercent,
  validateDiscountPrice,
  type ProductPricingInput,
} from "../src/pricing";

// The per-product discount price rules (docs/plans/product-discount.md §3, §5). Pure functions, no
// database.

const START = new Date("2026-11-01T00:00:00Z");
const END = new Date("2026-11-08T00:00:00Z");
const INSIDE = new Date("2026-11-03T12:00:00Z");

function pricing(overrides: Partial<ProductPricingInput> = {}): ProductPricingInput {
  return {
    basePrice: 350_000,
    discountPriceAmount: 279_000,
    discountEnabled: true,
    discountStartsAt: START,
    discountEndsAt: END,
    ...overrides,
  };
}

describe("discountPercentOff (the badge)", () => {
  test("floors the real percentage: 350.000 -> 279.000 is 20", () => {
    expect(discountPercentOff(350_000, 279_000)).toBe(20); // 20,28%
  });

  test("exact percentages stay exact", () => {
    expect(discountPercentOff(350_000, 280_000)).toBe(20);
    expect(discountPercentOff(200_000, 100_000)).toBe(50);
  });

  test("just under a whole percent floors down", () => {
    expect(discountPercentOff(100_000, 80_001)).toBe(19); // 19,999%
  });

  test("rejects non-integer or non-positive inputs", () => {
    expect(() => discountPercentOff(0, 0)).toThrow(RangeError);
    expect(() => discountPercentOff(350_000.5, 279_000)).toThrow(RangeError);
    expect(() => discountPercentOff(350_000, -1)).toThrow(RangeError);
  });
});

describe("discountPercentTenths (admin helper display)", () => {
  test("floors to one decimal, as tenths", () => {
    expect(discountPercentTenths(350_000, 279_000)).toBe(202); // 20,28% -> 20,2
    expect(discountPercentTenths(349_000, 279_000)).toBe(200); // 20,057% -> 20,0
    expect(discountPercentTenths(350_000, 280_000)).toBe(200);
  });
});

describe("salePriceFromPercent (round DOWN to Rp1.000, badge must equal the typed percent)", () => {
  test.each([
    [350_000, 20, 280_000],
    [349_000, 20, 279_000],
    [399_000, 15, 339_000],
    [189_000, 35, 122_000],
    [299_900, 1, 296_000],
    [99_000, 20, 79_000],
  ])("base %i at %i%% -> %i", (base, percent, expected) => {
    const sale = salePriceFromPercent(base, percent);
    expect(sale).toBe(expected);
    expect(discountPercentOff(base, expected)).toBe(percent);
  });

  test("returns null when rounding down would make the badge show more than the typed percent", () => {
    // exact 49.995 -> 49.000 is 2,97% off, which would read "2% OFF" for a typed 1%.
    expect(salePriceFromPercent(50_500, 1)).toBeNull();
  });

  test("returns null when the rounded price would be Rp0", () => {
    expect(salePriceFromPercent(1_500, 50)).toBeNull(); // exact 750 -> 0
  });

  test("for every base from Rp100.000 the result exists and its badge equals the typed percent", () => {
    // The plan's guarantee (§3.1). Sweeps bases in odd steps so most are not round numbers.
    for (let base = 100_000; base <= 2_000_000; base += 7_919) {
      for (let percent = 1; percent <= 99; percent += 1) {
        const sale = salePriceFromPercent(base, percent);
        expect(sale, `base ${base}, ${percent}%`).not.toBeNull();
        expect(sale! % 1_000).toBe(0);
        expect(discountPercentOff(base, sale!), `base ${base}, ${percent}%`).toBe(percent);
        expect(validateDiscountPrice(base, sale!)).toBeNull();
      }
    }
  });

  test("whenever a result exists, its badge never exceeds the typed percent (cheap bases too)", () => {
    for (let base = 1_000; base <= 120_000; base += 997) {
      for (let percent = 1; percent <= 99; percent += 1) {
        const sale = salePriceFromPercent(base, percent);
        if (sale === null) continue;
        expect(discountPercentOff(base, sale)).toBe(percent);
        expect(sale).toBeGreaterThan(0);
      }
    }
  });

  test("rejects a percent outside 1..99 or not whole, and a bad base", () => {
    expect(() => salePriceFromPercent(350_000, 0)).toThrow(RangeError);
    expect(() => salePriceFromPercent(350_000, 100)).toThrow(RangeError);
    expect(() => salePriceFromPercent(350_000, 20.5)).toThrow(RangeError);
    expect(() => salePriceFromPercent(0, 20)).toThrow(RangeError);
  });
});

describe("validateDiscountPrice", () => {
  test("accepts a sale price at least 1% below the base", () => {
    expect(validateDiscountPrice(350_000, 279_000)).toBeNull();
    expect(validateDiscountPrice(100_000, 99_000)).toBeNull(); // exactly 1%
  });

  test("refuses Rp0, negatives and fractions", () => {
    expect(validateDiscountPrice(350_000, 0)).toBe("not_positive");
    expect(validateDiscountPrice(350_000, -1)).toBe("not_positive");
    expect(validateDiscountPrice(350_000, 279_000.5)).toBe("not_positive");
  });

  test("refuses a sale price not below the base", () => {
    expect(validateDiscountPrice(350_000, 350_000)).toBe("not_below_base");
    expect(validateDiscountPrice(350_000, 400_000)).toBe("not_below_base");
  });

  test("refuses discounts under 1%", () => {
    expect(validateDiscountPrice(350_000, 349_000)).toBe("under_min_percent"); // 0,28%
    expect(validateDiscountPrice(100_000, 99_001)).toBe("under_min_percent"); // 0,999%
  });
});

describe("isDiscountActive / resolveUnitPrice: the window and the toggle", () => {
  test("active inside the window", () => {
    expect(isDiscountActive(pricing(), INSIDE)).toBe(true);
    expect(resolveUnitPrice(pricing(), INSIDE)).toEqual({
      listPrice: 350_000,
      unitPrice: 279_000,
      discounted: true,
      percentOff: 20,
      endsAt: END,
    });
  });

  test("active exactly at the start (inclusive)", () => {
    expect(isDiscountActive(pricing(), START)).toBe(true);
  });

  test("inactive one millisecond before the start", () => {
    expect(isDiscountActive(pricing(), new Date(START.getTime() - 1))).toBe(false);
  });

  test("inactive exactly at the end (exclusive) and after", () => {
    expect(isDiscountActive(pricing(), new Date(END.getTime() - 1))).toBe(true);
    expect(isDiscountActive(pricing(), END)).toBe(false);
    expect(isDiscountActive(pricing(), new Date(END.getTime() + 1))).toBe(false);
  });

  test("no start means from now; no end means open-ended", () => {
    const open = pricing({ discountStartsAt: null, discountEndsAt: null });
    expect(isDiscountActive(open, new Date("2020-01-01T00:00:00Z"))).toBe(true);
    expect(isDiscountActive(open, new Date("2099-01-01T00:00:00Z"))).toBe(true);
    expect(isDiscountActive(pricing({ discountStartsAt: null }), new Date("2020-01-01T00:00:00Z"))).toBe(true);
    expect(isDiscountActive(pricing({ discountEndsAt: null }), new Date("2099-01-01T00:00:00Z"))).toBe(true);
  });

  test("toggle off wins over the window", () => {
    expect(isDiscountActive(pricing({ discountEnabled: false }), INSIDE)).toBe(false);
  });

  test("no sale price is never active", () => {
    expect(isDiscountActive(pricing({ discountPriceAmount: null }), INSIDE)).toBe(false);
  });

  test("an invalid stored sale price is never applied (defensive; the DB CHECK forbids it)", () => {
    expect(isDiscountActive(pricing({ discountPriceAmount: 350_000 }), INSIDE)).toBe(false);
    expect(isDiscountActive(pricing({ discountPriceAmount: 349_000 }), INSIDE)).toBe(false);
  });

  test("an invalid date never applies the discount (fails closed)", () => {
    const invalid = new Date("not a date");
    expect(discountStatus(pricing(), invalid)).toBe("off");
    expect(discountStatus(pricing({ discountStartsAt: invalid }), INSIDE)).toBe("off");
    expect(discountStatus(pricing({ discountEndsAt: invalid }), INSIDE)).toBe("off");
    expect(resolveUnitPrice(pricing({ discountEndsAt: invalid }), INSIDE).unitPrice).toBe(350_000);
  });

  test("a base price of 0 with a stored sale price is never discounted", () => {
    expect(resolveUnitPrice(pricing({ basePrice: 0 }), INSIDE)).toEqual({
      listPrice: 0,
      unitPrice: 0,
      discounted: false,
      percentOff: null,
      endsAt: null,
    });
  });

  test("inactive resolves to the base price, with no badge and no end date", () => {
    expect(resolveUnitPrice(pricing({ discountEnabled: false }), INSIDE)).toEqual({
      listPrice: 350_000,
      unitPrice: 350_000,
      discounted: false,
      percentOff: null,
      endsAt: null,
    });
  });

  test("an open-ended active discount has no end date", () => {
    expect(resolveUnitPrice(pricing({ discountEndsAt: null }), INSIDE).endsAt).toBeNull();
  });
});

describe("resolveUnitPrice with a variant price override (admin manual orders only)", () => {
  test("no override behaves exactly like the product price", () => {
    expect(resolveUnitPrice(pricing(), INSIDE, { variantPriceOverride: null })).toEqual(resolveUnitPrice(pricing(), INSIDE));
  });

  test("an override above the sale price: list is the override, the sale price is charged", () => {
    expect(resolveUnitPrice(pricing(), INSIDE, { variantPriceOverride: 375_000 })).toEqual({
      listPrice: 375_000,
      unitPrice: 279_000,
      discounted: true,
      percentOff: 25, // 25,6%
      endsAt: END,
    });
  });

  test("an override at or below the sale price is never raised to it", () => {
    expect(resolveUnitPrice(pricing(), INSIDE, { variantPriceOverride: 250_000 })).toEqual({
      listPrice: 250_000,
      unitPrice: 250_000,
      discounted: false,
      percentOff: null,
      endsAt: null,
    });
    expect(resolveUnitPrice(pricing(), INSIDE, { variantPriceOverride: 279_000 }).discounted).toBe(false);
  });

  test("an override less than 1% above the sale price charges the override (no 0% OFF)", () => {
    // 99.500 -> 99.000 is 0,5% off the override: the 1% minimum holds against the list price too.
    const input = pricing({ basePrice: 100_000, discountPriceAmount: 99_000 });
    expect(resolveUnitPrice(input, INSIDE, { variantPriceOverride: 99_500 })).toEqual({
      listPrice: 99_500,
      unitPrice: 99_500,
      discounted: false,
      percentOff: null,
      endsAt: null,
    });
  });

  test("an override of 0 charges 0 without throwing", () => {
    expect(resolveUnitPrice(pricing(), INSIDE, { variantPriceOverride: 0 }).unitPrice).toBe(0);
  });

  test("an override with the discount inactive charges the override", () => {
    expect(resolveUnitPrice(pricing({ discountEnabled: false }), INSIDE, { variantPriceOverride: 375_000 }).unitPrice).toBe(375_000);
  });
});

describe("discountStatus (admin chip)", () => {
  test("off when the toggle is off or there is no price", () => {
    expect(discountStatus(pricing({ discountEnabled: false }), INSIDE)).toBe("off");
    expect(discountStatus(pricing({ discountPriceAmount: null, discountEnabled: false }), INSIDE)).toBe("off");
  });

  test("scheduled before the start, active inside, ended from the end on", () => {
    expect(discountStatus(pricing(), new Date(START.getTime() - 1))).toBe("scheduled");
    expect(discountStatus(pricing(), START)).toBe("active");
    expect(discountStatus(pricing(), INSIDE)).toBe("active");
    expect(discountStatus(pricing(), END)).toBe("ended");
  });

  test("an invalid stored sale price reads as off, matching isDiscountActive", () => {
    expect(discountStatus(pricing({ discountPriceAmount: 350_000 }), INSIDE)).toBe("off");
  });
});
