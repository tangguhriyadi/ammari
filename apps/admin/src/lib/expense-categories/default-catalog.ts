import { DEFAULT_EXPENSE_CATEGORIES } from "@ammari/db/schema";
import type { ExpenseCategoryInfo } from "./catalog";

// The ten seeded rows (migration 0048) as catalog entries, for pure unit tests that need a
// catalog without a database. The app itself always reads expense_categories
// (queries.ts getExpenseCategoryCatalog): never use this as the category list at runtime.

export const DEFAULT_EXPENSE_CATEGORY_INFOS: readonly ExpenseCategoryInfo[] = DEFAULT_EXPENSE_CATEGORIES.map((category) => ({ ...category, isActive: true }));

/** A seeded category by code; throws on a typo so a test never silently gets undefined. */
export function defaultExpenseCategory(code: string): ExpenseCategoryInfo {
  const category = DEFAULT_EXPENSE_CATEGORY_INFOS.find((entry) => entry.code === code);
  if (!category) throw new Error(`no seeded expense category "${code}"`);
  return category;
}
