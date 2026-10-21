import { describe, expect, test } from "vitest";
import {
  SHIPPING_PACKAGING_GRAMS,
  SHIPPING_SERVICE_ALLOWLIST,
  SHIPPING_SUBSIDY_MAX_AMOUNT,
  allowlistCourierCodes,
  allowlistedServices,
  formatShippingAreaLabel,
  normalizeProviderPostalCode,
  parcelWeightGrams,
  pickCheapestService,
  shippingAreaSearchText,
  splitShippingCost,
} from "./rules";

// docs/plans/cart-checkout.md §4.5 (D11, decisions 17 to 19), session 8: the money and weight
// rules behind every quote. Pure, so the checkout UI can share them.

describe("splitShippingCost", () => {
  test.each([
    [0, 0, 0],
    [19_999, 19_999, 0],
    [20_000, 20_000, 0],
    [20_001, 20_000, 1],
    [200_000, 20_000, 180_000],
  ])("cost %i: subsidy %i, buyer %i", (cost, subsidy, buyer) => {
    expect(splitShippingCost(cost)).toEqual({ costAmount: cost, subsidyAmount: subsidy, buyerAmount: buyer });
  });

  test("the cap is Rp20.000 and the parts always add up", () => {
    expect(SHIPPING_SUBSIDY_MAX_AMOUNT).toBe(20_000);
    for (const cost of [1, 7_500, 35_000, 95_000, 1_234_567]) {
      const split = splitShippingCost(cost);
      expect(split.subsidyAmount + split.buyerAmount).toBe(cost);
      expect(split.subsidyAmount).toBeLessThanOrEqual(SHIPPING_SUBSIDY_MAX_AMOUNT);
      expect(split.buyerAmount).toBe(Math.max(0, cost - SHIPPING_SUBSIDY_MAX_AMOUNT));
    }
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "refuses a cost that is not whole rupiah: %d",
    (cost) => {
      expect(() => splitShippingCost(cost)).toThrow(RangeError);
    },
  );
});

describe("parcelWeightGrams", () => {
  test("sums qty x piece weight plus one packaging allowance", () => {
    expect(
      parcelWeightGrams([
        { sku: "A", qty: 2, weightGrams: 650 },
        { sku: "B", qty: 1, weightGrams: 800 },
      ]),
    ).toEqual({ ok: true, grams: 2 * 650 + 800 + SHIPPING_PACKAGING_GRAMS });
  });

  test("packaging is 100 g per order, not per line", () => {
    expect(SHIPPING_PACKAGING_GRAMS).toBe(100);
    expect(parcelWeightGrams([{ sku: "A", qty: 1, weightGrams: 500 }])).toEqual({ ok: true, grams: 600 });
  });

  test("lists every SKU without a weight, once, sorted", () => {
    expect(
      parcelWeightGrams([
        { sku: "Z", qty: 1, weightGrams: null },
        { sku: "A", qty: 1, weightGrams: 700 },
        { sku: "M", qty: 2, weightGrams: null },
        { sku: "Z", qty: 1, weightGrams: null },
      ]),
    ).toEqual({ ok: false, reason: "missing_weight", missingSkus: ["M", "Z"] });
  });

  test("an empty order has no weight", () => {
    expect(parcelWeightGrams([])).toEqual({ ok: false, reason: "empty", missingSkus: [] });
  });

  test.each([0, -1, 1.5])("refuses a nonsense quantity: %d", (qty) => {
    expect(() => parcelWeightGrams([{ sku: "A", qty, weightGrams: 500 }])).toThrow(RangeError);
  });
});

describe("pickCheapestService", () => {
  test("ignores services outside the allowlist, even when cheaper", () => {
    const pick = pickCheapestService([
      { courierCode: "jne", serviceCode: "ctc", cost: 9_000 },
      { courierCode: "sicepat", serviceCode: "reg", cost: 15_000 },
      { courierCode: "jne", serviceCode: "yes", cost: 30_000 },
      { courierCode: "lion", serviceCode: "reg_pack", cost: 8_000 },
      { courierCode: "gojek", serviceCode: "instant", cost: 7_000 },
    ]);
    expect(pick).toEqual({ courierCode: "sicepat", serviceCode: "reg", label: "SiCepat Reguler", cost: 15_000 });
  });

  test("takes the lowest price", () => {
    const pick = pickCheapestService([
      { courierCode: "jne", serviceCode: "reg", cost: 18_000 },
      { courierCode: "pos", serviceCode: "kilat_khusus", cost: 16_000 },
      { courierCode: "jnt", serviceCode: "ez", cost: 17_000 },
    ]);
    expect(pick?.courierCode).toBe("pos");
    expect(pick?.cost).toBe(16_000);
  });

  test("ties are broken by allowlist order, whatever order the provider returns", () => {
    const services = [
      { courierCode: "pos", serviceCode: "kilat_khusus", cost: 12_000 },
      { courierCode: "sicepat", serviceCode: "reg", cost: 12_000 },
      { courierCode: "jnt", serviceCode: "ez", cost: 12_000 },
    ];
    expect(pickCheapestService(services)?.courierCode).toBe("jnt");
    expect(pickCheapestService([...services].reverse())?.courierCode).toBe("jnt");
  });

  test("matches codes case- and space-insensitively but returns the canonical codes", () => {
    const pick = pickCheapestService([{ courierCode: " POS ", serviceCode: "KILAT_KHUSUS ", cost: 10_000 }]);
    expect(pick).toEqual({ courierCode: "pos", serviceCode: "kilat_khusus", label: "POS Kilat Khusus", cost: 10_000 });
  });

  test("a zero, negative or fractional price is never picked", () => {
    expect(
      pickCheapestService([
        { courierCode: "jne", serviceCode: "reg", cost: 0 },
        { courierCode: "jnt", serviceCode: "ez", cost: -5 },
        { courierCode: "sicepat", serviceCode: "reg", cost: 10.5 },
      ]),
    ).toBeNull();
  });

  test("no allowlisted service: null", () => {
    expect(pickCheapestService([])).toBeNull();
    expect(pickCheapestService([{ courierCode: "jne", serviceCode: "ctc", cost: 9_000 }])).toBeNull();
  });

  test("the allowlist has no duplicates and only regular services", () => {
    const keys = SHIPPING_SERVICE_ALLOWLIST.map((entry) => `${entry.courierCode}:${entry.serviceCode}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of SHIPPING_SERVICE_ALLOWLIST) {
      expect(entry.label).not.toMatch(/\u2014/);
      expect(`${entry.serviceCode} ${entry.label}`).not.toMatch(/cod|instan|cargo|same ?day|yes|next_day/i);
    }
  });

  test("allowlistedServices keeps only pickable services, canonical codes, provider order", () => {
    expect(
      allowlistedServices([
        { courierCode: "POS", serviceCode: "Kilat_Khusus", cost: 20_000 },
        { courierCode: "jne", serviceCode: "ctc", cost: 9_000 },
        { courierCode: "jne", serviceCode: "reg", cost: 0 },
        { courierCode: "jnt", serviceCode: "ez", cost: 18_000 },
      ]),
    ).toEqual([
      { courierCode: "pos", serviceCode: "kilat_khusus", cost: 20_000 },
      { courierCode: "jnt", serviceCode: "ez", cost: 18_000 },
    ]);
  });

  test("one Rates call asks for each allowlisted courier once, in allowlist order", () => {
    expect(allowlistCourierCodes()).toEqual(["jne", "jnt", "sicepat", "idexpress", "anteraja", "pos"]);
    expect(allowlistCourierCodes([...SHIPPING_SERVICE_ALLOWLIST, { courierCode: "jne", serviceCode: "yes", label: "x" }])).toHaveLength(6);
  });
});

describe("normalizeProviderPostalCode", () => {
  test.each([
    ["40132", "40132"],
    [" 40132 ", "40132"],
    ["", null],
    ["0", null],
    ["4013", null],
    ["401320", null],
    ["04013", null],
    ["40l32", null],
    [null, null],
    [undefined, null],
    [40132, "40132"],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeProviderPostalCode(input)).toBe(expected);
  });
});

describe("formatShippingAreaLabel and shippingAreaSearchText", () => {
  const area = { province: "DKI Jakarta", city: "Jakarta Selatan", district: "Pesanggrahan", subdistrict: null, postalCode: "12250" };

  test("kecamatan, city, province and kode pos", () => {
    expect(formatShippingAreaLabel(area)).toBe("Pesanggrahan, Jakarta Selatan, DKI Jakarta 12250");
  });

  test("the kelurahan comes first when an area has one, and no kode pos leaves no trailing space", () => {
    expect(formatShippingAreaLabel({ ...area, subdistrict: "Bintaro", postalCode: null })).toBe(
      "Bintaro, Pesanggrahan, Jakarta Selatan, DKI Jakarta",
    );
  });

  test("search text is lowercase, accent-free and single spaced", () => {
    expect(shippingAreaSearchText({ ...area, district: "Pésanggrahan  (Kota)" })).toBe("pesanggrahan kota jakarta selatan dki jakarta 12250");
  });
});
