import { describe, expect, test } from "vitest";
import { lineOutflowValue, type LineDefectTotals } from "./valuation";

// docs/plans/suppliers-goods-receipt.md §10 R1: a return or release is valued at its SOURCE LINE's
// own defect value, by cumulative rounding over the line's net rejects, never at the item's pool.

const line = (rejectedQty: number, rejectedValue: number, outQty = 0, outValue = 0): LineDefectTotals => ({ rejectedQty, rejectedValue, outQty, outValue });

/** Apply a sequence of outflows to a line, returning each value. */
function drain(totals: LineDefectTotals, qtys: number[]): number[] {
  let current = totals;
  return qtys.map((qty) => {
    const value = lineOutflowValue(current, qty);
    current = { ...current, outQty: Math.round((current.outQty + qty) * 100) / 100, outValue: current.outValue + value };
    return value;
  });
}

describe("lineOutflowValue", () => {
  test("the whole held quantity takes exactly the held value", () => {
    expect(lineOutflowValue(line(5, 500), 5)).toBe(500);
    expect(lineOutflowValue(line(5, 100), 5)).toBe(100);
  });

  test("partial outflows over several steps sum exactly to the line's reject value, with cumulative rounding", () => {
    // Rp 1.000 over 3 pcs: cumulative targets 333, 667, 1000.
    expect(drain(line(3, 1_000), [1, 1, 1])).toEqual([333, 334, 333]);
    const values = drain(line(0.33, 33_000), [0.1, 0.07, 0.15, 0.01]);
    expect(values.reduce((sum, value) => sum + value, 0)).toBe(33_000);
    expect(values).toEqual([10_000, 7_000, 15_000, 1_000]);
    const awkward = drain(line(0.67, 67_003), [0.29, 0.38]);
    expect(awkward.reduce((sum, value) => sum + value, 0)).toBe(67_003);
    expect(awkward[0]).toBe(29_001); // round(67.003 × 29 / 67)
  });

  test("order-independent like a receipt slice: the cumulative value after k units is the same whatever the step sizes", () => {
    const a = drain(line(7, 1_001), [2, 3]);
    const b = drain(line(7, 1_001), [1, 4]);
    expect(a[0]! + a[1]!).toBe(b[0]! + b[1]!);
    expect(a[0]! + a[1]!).toBe(715); // round(1001 × 5 / 7)
  });

  test("after a reversal (exact negation of a middle outflow) the next outflows still sum exactly", () => {
    // 3 pcs Rp 1.000: out 1 (333), out 1 (334), reverse the first (outQty 1, outValue 334).
    const values = drain(line(3, 1_000, 1, 334), [1, 1]);
    expect(values[0]).toBe(333); // target 667 − 334
    expect(334 + values[0]! + values[1]!).toBe(1_000);
  });

  test("refuses zero, negative, and more than the line holds", () => {
    expect(() => lineOutflowValue(line(5, 500), 0)).toThrow();
    expect(() => lineOutflowValue(line(5, 500), -1)).toThrow();
    expect(() => lineOutflowValue(line(5, 500, 2, 200), 3.01)).toThrow();
  });

  test("legacy rows valued at the pooled average: a partial outflow is clamped to [0, held], the last one takes the exact remainder (even negative)", () => {
    // Line B: rejects 5 yd Rp 100, of which 2 yd were returned at the old pooled Rp 60/yd (120).
    // Held: 3 yd, Rp −20. Partial: clamped at 0; final: exactly −20, which zeroes the line.
    const legacy = line(5, 100, 2, 120);
    expect(lineOutflowValue(legacy, 1)).toBe(0);
    expect(lineOutflowValue(legacy, 3)).toBe(-20);
    // Over-booked the other way: held value above the target is not exceeded on a partial.
    expect(lineOutflowValue(line(5, 500, 2, 120), 1)).toBe(180); // target 300 − 120
  });
});
