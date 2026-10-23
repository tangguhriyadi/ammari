import { describe, expect, test } from "vitest";
import { snapshotListLineTotal, snapshotSavings } from "./line-savings";

describe("order line snapshot savings (docs/plans/product-discount.md §5.2)", () => {
  test("the struck total only when list_unit_price is above the charged price", () => {
    expect(snapshotListLineTotal({ qty: 2, unitPrice: 279_000, listUnitPrice: 350_000 })).toBe(700_000);
    expect(snapshotListLineTotal({ qty: 1, unitPrice: 299_000, listUnitPrice: null })).toBeNull();
    expect(snapshotListLineTotal({ qty: 1, unitPrice: 299_000, listUnitPrice: 299_000 })).toBeNull();
  });

  test("Hemat is the sum over discounted lines; 0 when none (older and marketplace orders)", () => {
    expect(
      snapshotSavings([
        { qty: 2, unitPrice: 279_000, listUnitPrice: 350_000 },
        { qty: 1, unitPrice: 299_000, listUnitPrice: null },
      ]),
    ).toBe(142_000);
    expect(snapshotSavings([{ qty: 1, unitPrice: 299_000, listUnitPrice: null }])).toBe(0);
    expect(snapshotSavings([])).toBe(0);
  });
});
