import { describe, expect, test } from "vitest";
import { productDiscountSummary } from "./product-discount-summary";

describe("productDiscountSummary", () => {
  test("is null when no line is discounted", () => {
    expect(productDiscountSummary([{ qty: 2, unitPrice: 350_000, listUnitPrice: null }], 700_000)).toBeNull();
    expect(productDiscountSummary([{ qty: 1, unitPrice: 350_000, listUnitPrice: 350_000 }], 350_000)).toBeNull();
  });

  test("a discounted line gives the normal total and the difference to the subtotal", () => {
    expect(productDiscountSummary([{ qty: 2, unitPrice: 279_000, listUnitPrice: 350_000 }], 558_000)).toEqual({ listTotal: 700_000, discount: 142_000 });
  });

  test("lines without a list price count at their paid price", () => {
    const items = [
      { qty: 2, unitPrice: 279_000, listUnitPrice: 350_000 },
      { qty: 1, unitPrice: 200_000, listUnitPrice: null },
    ];
    expect(productDiscountSummary(items, 758_000)).toEqual({ listTotal: 900_000, discount: 142_000 });
  });
});
