import type { ChannelId, ExpenseCategoryKind } from "@ammari/db/schema";
import { parseRupiah } from "@/lib/products/money";
import { EXPENSE_CATEGORY_GROUPS, type ExpenseCategoryGroup } from "@/lib/expenses/labels";

// "Kategori Biaya" as the app sees it (docs/plans/expense-master-data.md §3.5). Plain module, no
// `server-only`: the server reads the rows (queries.ts getExpenseCategoryCatalog) and passes them
// to client components as props, which use these helpers. Nothing here reads the database.

/** "Jenis" on the Data Master pages (plan §3.1): the owner picks it in these words. */
export const EXPENSE_CATEGORY_KIND_LABELS: Record<ExpenseCategoryKind, string> = {
  ad: "Iklan",
  endorsement: "Endorse",
  operating: "Operasional",
};

export interface ExpenseCategoryInfo {
  code: string;
  name: string;
  kind: ExpenseCategoryKind;
  fixedChannelId: ChannelId | null;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface ExpenseItemInfo {
  id: string;
  categoryCode: string;
  name: string;
  note: string | null;
  defaultAmount: number | null;
  sortOrder: number;
}

export interface ExpenseCategoryCatalog {
  /** Every category, inactive included (past expenses still show them), in display order
   * (sort_order, name, code). */
  categories: ExpenseCategoryInfo[];
  /** ACTIVE items only, in display order, for the record form. */
  items: ExpenseItemInfo[];
}

/** What the channel rule needs from a category: the same two columns the
 * business_expense_channel_rule trigger reads. */
export type ExpenseCategoryRule = Pick<ExpenseCategoryInfo, "kind" | "fixedChannelId">;

export function findExpenseCategory<T extends Pick<ExpenseCategoryInfo, "code">>(categories: readonly T[], code: string): T | undefined {
  return categories.find((category) => category.code === code);
}

/** The category's current name (renames apply to past expenses too, owner answer D6). The code
 * itself only for a row the catalog does not hold, which the FK makes impossible. */
export function expenseCategoryLabel(categories: readonly Pick<ExpenseCategoryInfo, "code" | "name">[], code: string): string {
  return findExpenseCategory(categories, code)?.name ?? code;
}

/** "Iklan" for ad and endorse categories, "Operasional" for the rest (plan §3.1). */
export function expenseGroupOfKind(kind: ExpenseCategoryKind): ExpenseCategoryGroup {
  return EXPENSE_CATEGORY_GROUPS.find((group) => (group.kinds as readonly ExpenseCategoryKind[]).includes(kind))!.key;
}

/** The categories of one group (or all), in display order. */
export function expenseCategoriesInGroup<T extends Pick<ExpenseCategoryInfo, "kind">>(categories: readonly T[], group: ExpenseCategoryGroup | undefined): T[] {
  return group === undefined ? [...categories] : categories.filter((category) => expenseGroupOfKind(category.kind) === group);
}

/** The categories a NEW expense or a new monthly-bill choice may use: active ones only. */
export function selectableExpenseCategories<T extends Pick<ExpenseCategoryInfo, "isActive">>(categories: readonly T[]): T[] {
  return categories.filter((category) => category.isActive);
}

// ---------- Items on a NEW expense (expense-master-data.md §3.5, session S4) ----------

export const EXPENSE_ITEM_MESSAGES = {
  itemRequired: "Pilih item biaya.",
} as const;

/** The active items of one category, in display order (`items` is the catalog's active list). */
export function expenseItemsOfCategory<T extends Pick<ExpenseItemInfo, "categoryCode">>(items: readonly T[], categoryCode: string): T[] {
  return items.filter((item) => item.categoryCode === categoryCode);
}

/** Owner answer D1 (no free-text item): a category with at least one active item REQUIRES an
 * item; one without any shows no item field at all. */
export function expenseItemRequirement(activeItemCount: number): "required" | "hidden" {
  return activeItemCount > 0 ? "required" : "hidden";
}

/** The rule both the form and the server apply: the error for a missing item, or null. A chosen
 * item's category and status are checked against the table (lockSelectableExpenseCategoryAndItem). */
export function expenseItemSelectionError(activeItemCount: number, itemId: string | null): string | null {
  return expenseItemRequirement(activeItemCount) === "required" && itemId === null ? EXPENSE_ITEM_MESSAGES.itemRequired : null;
}

/** What "Jumlah" holds after the item changes (owner answer D4). The user's own amount is never
 * touched; "untouched" means Jumlah is empty or still holds the previous item's default (by value,
 * so "149000" counts as "149.000"). An untouched Jumlah takes the new item's default, or is
 * cleared when the new item (or no item, after a category change) has none, so a default never
 * outlives the item it came from. `formatDefault` renders an amount the way the input shows it. */
export function amountAfterItemChange(
  currentAmount: string,
  previousDefault: number | null,
  nextDefault: number | null,
  formatDefault: (amount: number) => string,
): string {
  const holdsPreviousDefault = previousDefault !== null && parseRupiah(currentAmount) === previousDefault;
  if (currentAmount.trim() !== "" && !holdsPreviousDefault) return currentAmount;
  return nextDefault === null ? "" : formatDefault(nextDefault);
}
