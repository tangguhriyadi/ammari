import { describe, expect, test } from "vitest";
import { expenseCategoryHint, joinCategoryLabels } from "./labels";

describe("joinCategoryLabels", () => {
  test("Indonesian list of category labels", () => {
    expect(joinCategoryLabels(["Sewa"])).toBe("Sewa");
    expect(joinCategoryLabels(["Gaji", "Sewa"])).toBe("Gaji dan Sewa");
    expect(joinCategoryLabels(["Gaji", "Sewa", "Utilitas"])).toBe("Gaji, Sewa, dan Utilitas");
  });
});

describe("expenseCategoryHint", () => {
  test("seeded codes keep their hint; any other code has none", () => {
    expect(expenseCategoryHint("other")).toMatch(/catatan/);
    expect(expenseCategoryHint("langganan")).toBeUndefined();
    expect(expenseCategoryHint("toString")).toBeUndefined();
  });
});
