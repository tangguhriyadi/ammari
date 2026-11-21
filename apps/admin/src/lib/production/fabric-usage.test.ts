import { describe, expect, test } from "vitest";
import {
  estimateFabricUsageCost,
  formatYardsInput,
  pcsByFabricColor,
  splitYardsByPcs,
  sumUsageYards,
  usageShortfall,
} from "./fabric-usage";

describe("splitYardsByPcs (owner decision A4: default split by pcs per colour)", () => {
  test("splits the total in proportion to pcs per colour", () => {
    expect(
      splitYardsByPcs(30, [
        { fabricColorId: "sage", pcs: 6 },
        { fabricColorId: "mocca", pcs: 4 },
      ]),
    ).toEqual([
      { fabricColorId: "sage", yards: 18 },
      { fabricColorId: "mocca", yards: 12 },
    ]);
  });

  test("rounds down to 0.01 and puts the remainder on the colour with the most pcs, so it sums exactly", () => {
    const rows = splitYardsByPcs(10, [
      { fabricColorId: "a", pcs: 1 },
      { fabricColorId: "b", pcs: 1 },
      { fabricColorId: "c", pcs: 1 },
    ]);
    // 3.33 each, the 0.01 remainder on the first (tie).
    expect(rows).toEqual([
      { fabricColorId: "a", yards: 3.34 },
      { fabricColorId: "b", yards: 3.33 },
      { fabricColorId: "c", yards: 3.33 },
    ]);
    expect(sumUsageYards(rows)).toBe(10);
  });

  test("the remainder goes to the largest colour, not the first", () => {
    const rows = splitYardsByPcs(1, [
      { fabricColorId: "small", pcs: 1 },
      { fabricColorId: "big", pcs: 2 },
    ]);
    expect(rows).toEqual([
      { fabricColorId: "small", yards: 0.33 },
      { fabricColorId: "big", yards: 0.67 },
    ]);
  });

  test("sums exactly for awkward totals", () => {
    for (const total of [0.07, 12.34, 838, 99.99, 17.5]) {
      const rows = splitYardsByPcs(total, [
        { fabricColorId: "a", pcs: 7 },
        { fabricColorId: "b", pcs: 3 },
        { fabricColorId: "c", pcs: 11 },
      ]);
      expect(sumUsageYards(rows)).toBe(total);
    }
  });

  test("leaves out a colour whose share rounds to 0.00 (a usage row must be > 0)", () => {
    expect(
      splitYardsByPcs(0.01, [
        { fabricColorId: "a", pcs: 1 },
        { fabricColorId: "b", pcs: 5 },
      ]),
    ).toEqual([{ fabricColorId: "b", yards: 0.01 }]);
  });

  test("nothing to split: no total, a zero total, or no pcs", () => {
    expect(splitYardsByPcs(null, [{ fabricColorId: "a", pcs: 1 }])).toEqual([]);
    expect(splitYardsByPcs(0, [{ fabricColorId: "a", pcs: 1 }])).toEqual([]);
    expect(splitYardsByPcs(10, [])).toEqual([]);
    expect(splitYardsByPcs(10, [{ fabricColorId: "a", pcs: 0 }])).toEqual([]);
  });
});

describe("pcsByFabricColor", () => {
  test("sums pcs per colour across sizes and products, in order of first appearance", () => {
    expect(
      pcsByFabricColor([
        { colorId: "sage", qty: 2 },
        { colorId: "mocca", qty: 3 },
        { colorId: "sage", qty: 4 },
        { colorId: "tosca", qty: 0 },
      ]),
    ).toEqual([
      { fabricColorId: "sage", pcs: 6 },
      { fabricColorId: "mocca", pcs: 3 },
    ]);
  });
});

describe("usageShortfall / formatYardsInput", () => {
  test("shortfall in whole hundredths, never negative", () => {
    expect(usageShortfall(10, 6.8)).toBe(3.2);
    expect(usageShortfall(0.3, 0.1 + 0.2)).toBe(0);
    expect(usageShortfall(5, 9)).toBe(0);
    expect(usageShortfall(5, -1)).toBe(6);
  });

  test("input text without trailing zeros", () => {
    expect(formatYardsInput(12.5)).toBe("12.5");
    expect(formatYardsInput(10)).toBe("10");
    expect(formatYardsInput(0.1 + 0.2)).toBe("0.3");
  });
});

describe("estimateFabricUsageCost (each bucket at its own average, A1)", () => {
  const balances = new Map<string | null, { qty: number; valueAmount: number }>([
    ["sage", { qty: 10, valueAmount: 195_000 }],
    ["mocca", { qty: 8, valueAmount: 240_000 }],
    [null, { qty: 0, valueAmount: 0 }],
  ]);

  test("Σ yards × the row's own bucket average", () => {
    expect(
      estimateFabricUsageCost(
        [
          { fabricColorId: "sage", yards: 4 },
          { fabricColorId: "mocca", yards: 2 },
        ],
        (source) => balances.get(source),
      ),
    ).toBe(4 * 19_500 + 2 * 30_000);
  });

  test("null when a row's bucket has no average yet, or there are no rows", () => {
    expect(estimateFabricUsageCost([{ fabricColorId: null, yards: 1 }], (source) => balances.get(source))).toBeNull();
    expect(estimateFabricUsageCost([{ fabricColorId: "unknown", yards: 1 }], (source) => balances.get(source))).toBeNull();
    expect(estimateFabricUsageCost([], (source) => balances.get(source))).toBeNull();
  });
});
