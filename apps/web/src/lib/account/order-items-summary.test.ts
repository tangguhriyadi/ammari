import { describe, expect, test } from "vitest";
import { orderItemsSummary } from "./order-items-summary";

describe("orderItemsSummary", () => {
  test('shows an All Size line as "All Size", never the raw ALLSIZE code, and sized lines as stored', () => {
    const summary = orderItemsSummary([
      { productName: "Gamis A", colorName: "Sage", size: "ALLSIZE", qty: 1 },
      { productName: "Gamis B", colorName: "Hitam", size: "M", qty: 2 },
    ]);
    expect(summary).toBe("Gamis A (Sage, All Size) x1, Gamis B (Hitam, M) x2");
    expect(summary).not.toContain("ALLSIZE");
  });

  test("no items is an empty string", () => {
    expect(orderItemsSummary([])).toBe("");
  });
});
