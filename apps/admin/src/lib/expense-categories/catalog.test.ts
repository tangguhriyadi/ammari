import { describe, expect, test } from "vitest";
import { formatNumber } from "@ammari/ui/lib";
import { amountAfterItemChange, expenseItemRequirement, expenseItemSelectionError, expenseItemsOfCategory } from "./catalog";

// docs/plans/expense-master-data.md §3.5, session S4: the item rules the record form and the server
// share (D1: no free-text item; D4: an optional default amount that never overrides the user).

const ITEMS = [
  { id: "a", categoryCode: "langganan", name: "Biteship Grow", defaultAmount: 149_000 },
  { id: "b", categoryCode: "langganan", name: "Claude", defaultAmount: null },
  { id: "c", categoryCode: "packaging", name: "Kardus", defaultAmount: 2_000 },
];

describe("item required or hidden", () => {
  test("only the category's own items are offered, in catalog order", () => {
    expect(expenseItemsOfCategory(ITEMS, "langganan").map((item) => item.id)).toEqual(["a", "b"]);
    expect(expenseItemsOfCategory(ITEMS, "salary")).toEqual([]);
  });

  test("required when the category has active items, hidden when it has none", () => {
    expect(expenseItemRequirement(2)).toBe("required");
    expect(expenseItemRequirement(0)).toBe("hidden");
    expect(expenseItemSelectionError(2, null)).toBe("Pilih item biaya.");
    expect(expenseItemSelectionError(2, "a")).toBeNull();
    expect(expenseItemSelectionError(0, null)).toBeNull();
  });
});

describe("default amount fill", () => {
  const fill = (current: string, previous: number | null, next: number | null) => amountAfterItemChange(current, previous, next, formatNumber);

  test("an empty Jumlah takes the item's default", () => {
    expect(fill("", null, 149_000)).toBe("149.000");
    expect(fill("  ", null, 149_000)).toBe("149.000");
  });

  test("a Jumlah still holding the previous item's default (by value) takes the new one", () => {
    expect(fill("149.000", 149_000, 2_000)).toBe("2.000");
    expect(fill("149000", 149_000, 2_000)).toBe("2.000");
  });

  test("an amount the user typed is never replaced", () => {
    expect(fill("150.000", 149_000, 2_000)).toBe("150.000");
    expect(fill("150.000", null, 149_000)).toBe("150.000");
    expect(fill("abc", 149_000, 2_000)).toBe("abc");
  });

  test("an untouched default is cleared when the next item (or no item) has none", () => {
    expect(fill("149.000", 149_000, null)).toBe("");
    expect(fill("", null, null)).toBe("");
    expect(fill("75.000", 149_000, null)).toBe("75.000");
  });
});
