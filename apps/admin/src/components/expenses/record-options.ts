import { expenseCategoriesInGroup, selectableExpenseCategories, type ExpenseCategoryCatalog } from "@/lib/expense-categories/catalog";
import type { ExpenseCategoryGroup } from "@/lib/expenses/labels";
import type { RecordExpenseCategoryOption, RecordExpenseItemOption } from "./record-expense-button";

/** What one menu's record form may offer (docs/plans/expense-master-data.md §3.5, §3.8): the ACTIVE
 * categories of the menu's group, with their active items (the catalog's items are the active
 * ones already). Only the fields the client needs are sent. */
export function recordExpenseOptions(
  { categories, items }: ExpenseCategoryCatalog,
  scope: ExpenseCategoryGroup,
): { categories: RecordExpenseCategoryOption[]; items: RecordExpenseItemOption[] } {
  const options = expenseCategoriesInGroup(selectableExpenseCategories(categories), scope).map(({ code, name, kind, fixedChannelId }) => ({ code, name, kind, fixedChannelId }));
  const codes = new Set(options.map((category) => category.code));
  return {
    categories: options,
    items: items.filter((item) => codes.has(item.categoryCode)).map(({ id, categoryCode, name, note, defaultAmount }) => ({ id, categoryCode, name, note, defaultAmount })),
  };
}
