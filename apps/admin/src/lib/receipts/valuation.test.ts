import { describe, expect, test } from "vitest";
import { cumulativeValue, sliceValue, splitSlice, toCentiQty } from "./valuation";

// docs/plans/suppliers-goods-receipt.md §4.2: each receipt is a cumulative-rounding slice of the
// line's total, so partial receipts sum to EXACTLY what was paid.

/** Posts `arrivals` against one line in order and returns each slice. */
function sliceAll(totalAmount: number, qtyOrdered: number, arrivals: number[]): number[] {
  let settled = 0;
  let booked = 0;
  return arrivals.map((qtyNow) => {
    const value = sliceValue({ totalAmount, qtyOrdered, settledBefore: settled, valueBefore: booked, qtyNow });
    settled = (Math.round(settled * 100) + Math.round(qtyNow * 100)) / 100;
    booked += value;
    return value;
  });
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe("toCentiQty", () => {
  test("is exact for two-decimal quantities that are not exact in binary", () => {
    expect(toCentiQty(0.29)).toBe(29n);
    expect(toCentiQty(0.35)).toBe(35n);
    expect(toCentiQty(10)).toBe(1000n);
  });
});

describe("sliceValue: exactness", () => {
  test("three partial receipts of a 3-unit line sum to exactly the total (no stranded rupiah)", () => {
    const slices = sliceAll(1_000_000, 3, [1, 1, 1]);
    expect(slices).toEqual([333_333, 333_334, 333_333]);
    expect(sum(slices)).toBe(1_000_000);
  });

  test("a rounding-boundary total: Rp 100 for 3 pcs, received 1 + 2", () => {
    const slices = sliceAll(100, 3, [1, 2]);
    expect(slices).toEqual([33, 67]);
    expect(sum(slices)).toBe(100);
  });

  test("half-up at an exact .5 boundary (Rp 5 for 2 units, receive 1: 2.5 rounds to 3)", () => {
    expect(sliceAll(5, 2, [1, 1])).toEqual([3, 2]);
  });

  test("fractional yards: 10.5 yards for Rp 1.234.567 in 0.35 + 3.15 + 7 yards", () => {
    const slices = sliceAll(1_234_567, 10.5, [0.35, 3.15, 7]);
    expect(sum(slices)).toBe(1_234_567);
    expect(slices.every((value) => value >= 0)).toBe(true);
  });

  test("a single full receipt is exactly the total", () => {
    expect(sliceAll(987_654, 7, [7])).toEqual([987_654]);
  });

  test("Rp 0 lines value every slice at 0", () => {
    expect(sliceAll(0, 4, [1, 3])).toEqual([0, 0]);
  });

  test("a short-closed line is valued at exactly what arrived (the cumulative value at the settled qty)", () => {
    const slices = sliceAll(1_000_000, 10, [3, 4]);
    expect(sum(slices)).toBe(cumulativeValue(1_000_000, toCentiQty(10), toCentiQty(7)));
    expect(sum(slices)).toBe(700_000);
  });

  test("many random partial sequences always sum to exactly the total and never go negative", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let run = 0; run < 500; run += 1) {
      const orderedCenti = 1 + Math.floor(random() * 5000);
      const total = Math.floor(random() * 50_000_000);
      const arrivals: number[] = [];
      let left = orderedCenti;
      while (left > 0) {
        const take = Math.min(left, 1 + Math.floor(random() * left));
        arrivals.push(take / 100);
        left -= take;
      }
      const slices = sliceAll(total, orderedCenti / 100, arrivals);
      expect(sum(slices)).toBe(total);
      expect(slices.every((value) => value >= 0)).toBe(true);
    }
  });
});

describe("sliceValue: reversals", () => {
  test("reversing a receipt that is not the latest still lets the line complete at exactly the total", () => {
    // Rp 7 for 3 units. A: 0 → 1 (round(7/3) = 2), B: 1 → 2 (round(14/3) = 5, so 3).
    const total = 7;
    const ordered = 3;
    const a = sliceValue({ totalAmount: total, qtyOrdered: ordered, settledBefore: 0, valueBefore: 0, qtyNow: 1 });
    const b = sliceValue({ totalAmount: total, qtyOrdered: ordered, settledBefore: 1, valueBefore: a, qtyNow: 1 });
    expect([a, b]).toEqual([2, 3]);
    // Reverse A exactly: settled 1, booked = b = 3 (the plain formula would assume round(7/3) = 2).
    const c = sliceValue({ totalAmount: total, qtyOrdered: ordered, settledBefore: 1, valueBefore: b, qtyNow: 2 });
    expect(b + c).toBe(total);
  });

  test("a slice is clamped at 0, and the completing slice absorbs it", () => {
    expect(sliceValue({ totalAmount: 10, qtyOrdered: 10, settledBefore: 3, valueBefore: 5, qtyNow: 1 })).toBe(0);
    expect(sliceValue({ totalAmount: 10, qtyOrdered: 10, settledBefore: 4, valueBefore: 5, qtyNow: 6 })).toBe(5);
  });
});

describe("sliceValue: guards", () => {
  test("refuses an arrival beyond the ordered quantity", () => {
    expect(() => sliceValue({ totalAmount: 100, qtyOrdered: 2, settledBefore: 1.5, valueBefore: 75, qtyNow: 0.51 })).toThrow();
  });

  test("refuses a non-positive arrival", () => {
    expect(() => sliceValue({ totalAmount: 100, qtyOrdered: 2, settledBefore: 0, valueBefore: 0, qtyNow: 0 })).toThrow();
  });
});

describe("splitSlice (§4.2, S5): one slice split between the sellable and the defect ledger", () => {
  test("8 good + 2 defective of a Rp 1.000.000 slice: 800.000 sellable, 200.000 defect", () => {
    expect(splitSlice(1_000_000, 8, 2)).toEqual({ accepted: 800_000, rejected: 200_000 });
  });

  test("the two parts always sum to exactly the slice, both non-negative, across awkward splits", () => {
    for (const [slice, accepted, rejected] of [
      [1, 1, 1],
      [10, 1, 2],
      [333_333, 0.33, 0.67],
      [7, 2.5, 0.01],
      [1_000_001, 3, 7],
      [0, 1, 1],
    ] as const) {
      const parts = splitSlice(slice, accepted, rejected);
      expect(parts.accepted + parts.rejected).toBe(slice);
      expect(parts.accepted).toBeGreaterThanOrEqual(0);
      expect(parts.rejected).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(parts.accepted)).toBe(true);
    }
  });

  test("rounds half up on integers, never float multiplication (1 of 2 units of Rp 3 is Rp 2)", () => {
    expect(splitSlice(3, 1, 1)).toEqual({ accepted: 2, rejected: 1 });
    expect(splitSlice(10, 0.35, 0.65)).toEqual({ accepted: 4, rejected: 6 });
  });

  test("all accepted or all rejected puts the whole slice on one side", () => {
    expect(splitSlice(12_345, 5, 0)).toEqual({ accepted: 12_345, rejected: 0 });
    expect(splitSlice(12_345, 0, 5)).toEqual({ accepted: 0, rejected: 12_345 });
  });

  test("a fully settled line (slices over accepted + rejected) sums to exactly total_amount with no stranded rupiah", () => {
    const total = 1_000_003;
    const ordered = 9.99;
    // Three arrivals of (accepted, rejected): settled is the sum of both.
    const arrivals: [number, number][] = [
      [3.33, 0.5],
      [2, 1.16],
      [1, 2],
    ];
    let settled = 0;
    let booked = 0;
    let sellable = 0;
    let defect = 0;
    for (const [accepted, rejected] of arrivals) {
      const qtyNow = (Math.round(accepted * 100) + Math.round(rejected * 100)) / 100;
      const slice = sliceValue({ totalAmount: total, qtyOrdered: ordered, settledBefore: settled, valueBefore: booked, qtyNow });
      const parts = splitSlice(slice, accepted, rejected);
      sellable += parts.accepted;
      defect += parts.rejected;
      booked += slice;
      settled = (Math.round(settled * 100) + Math.round(qtyNow * 100)) / 100;
    }
    expect(settled).toBe(ordered);
    expect(sellable + defect).toBe(total);
  });

  test("refuses a negative slice or an empty arrival", () => {
    expect(() => splitSlice(-1, 1, 1)).toThrow();
    expect(() => splitSlice(10, 0, 0)).toThrow();
    expect(() => splitSlice(10, -1, 2)).toThrow();
  });
});
