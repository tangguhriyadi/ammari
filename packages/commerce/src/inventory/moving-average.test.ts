import { describe, expect, test } from "vitest";
import { averageCostPerUnit, valueDeltaForConsumption } from "./moving-average";

describe("averageCostPerUnit", () => {
  test("is the value/qty ratio when qty > 0", () => {
    expect(averageCostPerUnit({ qty: 3, valueAmount: 10 })).toBeCloseTo(10 / 3);
  });

  test("is null when qty is 0", () => {
    expect(averageCostPerUnit({ qty: 0, valueAmount: 0 })).toBeNull();
  });

  test("is null when qty is negative (should never happen, but must not divide the wrong way)", () => {
    expect(averageCostPerUnit({ qty: -1, valueAmount: 5 })).toBeNull();
  });
});

describe("valueDeltaForConsumption", () => {
  test("rounds qtyDelta * average normally when it doesn't bring qty to exactly zero", () => {
    // balance: qty=3, value=10 -> average = 10/3 = 3.333...; consuming 1 of 3.
    const result = valueDeltaForConsumption({ qty: 3, valueAmount: 10 }, -1);
    expect(result).toBe(Math.round(-1 * (10 / 3)));
  });

  test("correction #1: consuming the full remaining qty clears value to EXACTLY 0, not a separately-rounded amount", () => {
    const result = valueDeltaForConsumption({ qty: 3, valueAmount: 10 }, -3);
    expect(result).toBe(-10);
    // Confirms the balance invariant directly: qty=0 => value=0.
    expect(10 + result).toBe(0);
  });

  test("correction #1 holds even for a balance whose average is a non-terminating decimal", () => {
    // 1/3 is the textbook IEEE754 example where naive round(qty * (value/qty)) could in
    // principle drift — the zero-floor branch must still land on exactly -valueAmount.
    const result = valueDeltaForConsumption({ qty: 3, valueAmount: 1 }, -3);
    expect(result).toBe(-1);
  });

  test("a positive adjustment from zero stock is valued at 0 (no cost basis yet)", () => {
    const result = valueDeltaForConsumption({ qty: 0, valueAmount: 0 }, 5);
    expect(result).toBe(0);
  });

  test("a positive adjustment from nonzero stock is valued at the current average, leaving it unchanged", () => {
    // balance: qty=10, value=10000 (avg=1000); adjustment +5 "found" units.
    const before = { qty: 10, valueAmount: 10000 };
    const result = valueDeltaForConsumption(before, 5);
    expect(result).toBe(5000);
    const after = { qty: before.qty + 5, valueAmount: before.valueAmount + result };
    expect(after.valueAmount / after.qty).toBe(1000); // average unchanged by an adjustment
  });

  test("a full sequential purchase -> consume -> consume-to-zero run leaves SUM(value)=0 exactly", () => {
    // Simulates what accessories.ts actually does, one movement at a time, re-deriving the
    // balance fresh each step (never carrying a rounded average forward) — the end-to-end
    // invariant this correction protects.
    let balance = { qty: 0, valueAmount: 0 };
    const applyPurchase = (qty: number, valueAmount: number) => {
      balance = { qty: balance.qty + qty, valueAmount: balance.valueAmount + valueAmount };
    };
    const applyConsumption = (qtyDelta: number) => {
      const valueDelta = valueDeltaForConsumption(balance, qtyDelta);
      balance = { qty: balance.qty + qtyDelta, valueAmount: balance.valueAmount + valueDelta };
    };

    applyPurchase(3, 10); // avg 3.333
    applyConsumption(-2); // consume 2 of 3
    applyPurchase(2, 7); // buy 2 more
    applyConsumption(-3); // consume the rest

    expect(balance.qty).toBe(0);
    expect(balance.valueAmount).toBe(0);
  });
});
