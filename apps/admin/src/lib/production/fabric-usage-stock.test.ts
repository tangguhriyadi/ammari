import { describe, expect, test } from "vitest";
import { toFabricUsageStock } from "./fabric-usage-stock";

const rows = [
  { fabricColorId: "sage", name: "Sage", hex: "#9caf88", isActive: true, hasMovements: true, qty: 10, valueAmount: 195_000 },
  { fabricColorId: null, name: null, hex: null, isActive: true, hasMovements: true, qty: 3.45, valueAmount: 69_000 },
];

describe("toFabricUsageStock (cost data only with finance.view_profit)", () => {
  test("without finance.view_profit every value is null; quantities stay", () => {
    expect(toFabricUsageStock(rows, false)).toEqual([
      { fabricColorId: "sage", name: "Sage", hex: "#9caf88", isActive: true, qty: 10, valueAmount: null },
      { fabricColorId: null, name: null, hex: null, isActive: true, qty: 3.45, valueAmount: null },
    ]);
  });

  test("with finance.view_profit the values pass through", () => {
    expect(toFabricUsageStock(rows, true).map((row) => row.valueAmount)).toEqual([195_000, 69_000]);
  });
});
