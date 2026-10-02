import { describe, expect, test } from "vitest";
import { meterPriceToYardPrice, yardPriceToMeterPrice } from "./fabric-price";

describe("meterPriceToYardPrice", () => {
  test("converts a round meter price", () => {
    // 85,000 * 0.9144 = 77,724 exactly
    expect(meterPriceToYardPrice(85_000)).toBe(77_724);
  });

  test("rounds to the nearest whole rupiah", () => {
    // 75,000 * 0.9144 = 68,580 exactly — pick a value that doesn't divide evenly instead.
    expect(meterPriceToYardPrice(77_777)).toBe(Math.round(77_777 * 0.9144));
  });

  test("null in, null out", () => {
    expect(meterPriceToYardPrice(null)).toBeNull();
  });

  test("zero converts to zero", () => {
    expect(meterPriceToYardPrice(0)).toBe(0);
  });
});

describe("yardPriceToMeterPrice", () => {
  test("converts a round yard price", () => {
    expect(yardPriceToMeterPrice(77_724)).toBe(85_000);
  });

  test("rounds to the nearest whole rupiah", () => {
    expect(yardPriceToMeterPrice(77_777)).toBe(Math.round(77_777 / 0.9144));
  });

  test("null in, null out", () => {
    expect(yardPriceToMeterPrice(null)).toBeNull();
  });

  test("round-trips back to the original value for an exact conversion", () => {
    const meter = 85_000;
    const yard = meterPriceToYardPrice(meter);
    expect(yardPriceToMeterPrice(yard)).toBe(meter);
  });
});
