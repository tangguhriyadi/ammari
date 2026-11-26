import { describe, expect, test } from "vitest";
import { EXPENSE_CATEGORY_KINDS } from "@ammari/db/schema";
import { expenseGroupOfKind } from "@/lib/expense-categories/catalog";
import { EXPENSE_CATEGORY_GROUPS, expenseCategoryHint, joinCategoryLabels } from "./labels";
import { expenseMenuPath } from "./search-params";

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

describe("every category kind has exactly one group, hence one menu (expense-master-data.md §3.8)", () => {
  test("ad and endorse on Iklan, operating on Biaya; a new kind without a group fails here", () => {
    for (const kind of EXPENSE_CATEGORY_KINDS) {
      expect(EXPENSE_CATEGORY_GROUPS.filter((group) => (group.kinds as readonly string[]).includes(kind))).toHaveLength(1);
    }
    expect(EXPENSE_CATEGORY_KINDS.map((kind) => expenseMenuPath(expenseGroupOfKind(kind)))).toEqual(EXPENSE_CATEGORY_KINDS.map((kind) => (kind === "operating" ? "/expenses" : "/ads")));
  });
});
