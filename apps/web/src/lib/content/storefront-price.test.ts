import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { DISCOUNT_COLOR_HEX } from "@ammari/db/pricing";
import { priceTiles, priceValidUntil, resolveStorefrontPrice, toStorefrontPrice, type CachedProductTile, type StorefrontPricingInput } from "./storefront-price";

// docs/plans/product-discount.md §7: the cache holds the raw fields, the price is decided here per
// request. Window: 1 Nov 2026 00:00 WIB to 8 Nov 2026 00:00 WIB.
const STARTS_AT = new Date("2026-10-31T17:00:00Z");
const ENDS_AT = new Date("2026-11-07T17:00:00Z");

function pricing(overrides: Partial<StorefrontPricingInput> = {}): StorefrontPricingInput {
  return { basePrice: 350_000, discountPriceAmount: 279_000, discountEnabled: true, discountStartsAt: STARTS_AT, discountEndsAt: ENDS_AT, ...overrides };
}

const SALE = { listPrice: 350_000, unitPrice: 279_000, discounted: true, percentOff: 20 };
const NORMAL = { listPrice: 350_000, unitPrice: 350_000, discounted: false, percentOff: null };

describe("resolveStorefrontPrice", () => {
  test("scheduled, not started yet: the normal price, nothing about the discount (owner answer 9)", () => {
    expect(toStorefrontPrice(resolveStorefrontPrice(pricing(), new Date(STARTS_AT.getTime() - 1)))).toEqual(NORMAL);
  });

  test("active from exactly the start time, with the floored badge percent", () => {
    expect(toStorefrontPrice(resolveStorefrontPrice(pricing(), STARTS_AT))).toEqual(SALE);
  });

  test("gone at exactly the end time", () => {
    expect(toStorefrontPrice(resolveStorefrontPrice(pricing(), new Date(ENDS_AT.getTime() - 1)))).toEqual(SALE);
    expect(toStorefrontPrice(resolveStorefrontPrice(pricing(), ENDS_AT))).toEqual(NORMAL);
  });

  test("a cache hit's ISO strings resolve exactly like the Dates (unstable_cache stores JSON)", () => {
    const fromCache = JSON.parse(JSON.stringify(pricing())) as StorefrontPricingInput;
    expect(typeof fromCache.discountStartsAt).toBe("string");
    expect(toStorefrontPrice(resolveStorefrontPrice(fromCache, new Date(STARTS_AT.getTime() - 1)))).toEqual(NORMAL);
    expect(toStorefrontPrice(resolveStorefrontPrice(fromCache, STARTS_AT))).toEqual(SALE);
    expect(toStorefrontPrice(resolveStorefrontPrice(fromCache, ENDS_AT))).toEqual(NORMAL);
    expect(resolveStorefrontPrice(fromCache, STARTS_AT).endsAt).toEqual(ENDS_AT);
  });

  test("an unparseable stored bound fails closed: the normal price", () => {
    expect(toStorefrontPrice(resolveStorefrontPrice(pricing({ discountEndsAt: "not a date" }), STARTS_AT))).toEqual(NORMAL);
  });

  test("toggle off or no sale price: the normal price", () => {
    expect(toStorefrontPrice(resolveStorefrontPrice(pricing({ discountEnabled: false }), STARTS_AT))).toEqual(NORMAL);
    expect(toStorefrontPrice(resolveStorefrontPrice(pricing({ discountPriceAmount: null, discountEnabled: false }), STARTS_AT))).toEqual(NORMAL);
  });
});

describe("priceTiles", () => {
  test("replaces the raw pricing with this request's price, everything else untouched", () => {
    const tile: CachedProductTile = {
      productId: "p1",
      fabricColorId: null,
      name: "Haura Dress",
      slug: "haura-dress",
      pricing: JSON.parse(JSON.stringify(pricing())) as StorefrontPricingInput,
      colorName: "Taupe",
      colorCount: 2,
      image: null,
      soldOut: true,
    };
    const [priced] = priceTiles([tile], STARTS_AT);
    expect(priced).toEqual({ productId: "p1", fabricColorId: null, name: "Haura Dress", slug: "haura-dress", colorName: "Taupe", colorCount: 2, image: null, soldOut: true, price: SALE });
    expect(priced).not.toHaveProperty("pricing");
  });
});

describe("priceValidUntil (JSON-LD)", () => {
  test("the last Asia/Jakarta date the sale price applies on: an end at 00:00 WIB counts the day before", () => {
    // ENDS_AT is 8 Nov 2026 00:00 WIB (exclusive), so the last sale day is 7 Nov.
    expect(priceValidUntil(resolveStorefrontPrice(pricing(), STARTS_AT))).toBe("2026-11-07");
    // Ending 8 Nov 15:00 WIB: still sold at the sale price on 8 Nov.
    expect(priceValidUntil(resolveStorefrontPrice(pricing({ discountEndsAt: new Date("2026-11-08T08:00:00Z") }), STARTS_AT))).toBe("2026-11-08");
  });

  test("absent when the discount has no end, or nothing is discounted", () => {
    expect(priceValidUntil(resolveStorefrontPrice(pricing({ discountEndsAt: null }), STARTS_AT))).toBeUndefined();
    expect(priceValidUntil(resolveStorefrontPrice(pricing(), ENDS_AT))).toBeUndefined();
  });
});

describe("discount colour token", () => {
  test("the storefront theme's --color-discount equals the shared constant the emails use", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    const token = /--color-discount:\s*(#[0-9a-fA-F]{6});/.exec(css)?.[1];
    expect(token?.toUpperCase()).toBe(DISCOUNT_COLOR_HEX.toUpperCase());
    expect(DISCOUNT_COLOR_HEX).toBe("#D05D5C");
  });
});
