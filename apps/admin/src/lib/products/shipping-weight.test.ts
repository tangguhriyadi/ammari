import { describe, expect, test } from "vitest";
import { SHIPPING_WEIGHT_RANGE_MESSAGE, shippingWeightString } from "./shipping-weight";

describe("shippingWeightString", () => {
  test("empty means not filled in yet", () => {
    expect(shippingWeightString.parse("")).toBeNull();
    expect(shippingWeightString.parse("   ")).toBeNull();
  });

  test("whole grams, with or without thousands dots", () => {
    expect(shippingWeightString.parse("850")).toBe(850);
    expect(shippingWeightString.parse(" 50 ")).toBe(50);
    expect(shippingWeightString.parse("1.200")).toBe(1200);
    expect(shippingWeightString.parse("30.000")).toBe(30000);
  });

  test("outside 50 to 30.000 gram is refused with the range message", () => {
    for (const value of ["0", "49", "30001", "30.001"]) {
      const result = shippingWeightString.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(SHIPPING_WEIGHT_RANGE_MESSAGE);
    }
    expect(SHIPPING_WEIGHT_RANGE_MESSAGE).toBe("Berat kirim harus 50 sampai 30.000 gram.");
  });

  test("decimals, units and other text are refused", () => {
    for (const value of ["0,8", "1,2 kg", "850g", "-100", "12.34", "abc", "1.2.3"]) {
      expect(shippingWeightString.safeParse(value).success, value).toBe(false);
    }
  });
});
