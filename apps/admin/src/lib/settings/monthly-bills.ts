import "server-only";
import { eq } from "drizzle-orm";
import { salesGoal, type BusinessExpenseCategory } from "@ammari/db/schema";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";

// "Pengingat biaya bulanan" (docs/plans/growth.md §6, owner answer A6): which expense categories
// must be recorded every month, kept on the one sales_goal row (migration 0043). Edited on
// /settings under settings.manage + finance.view_profit, like Target penjualan; read by the
// "Gaji/Sewa belum dicatat" item (lib/expenses/summary.ts). Empty = reminder off. Since
// expense-master-data.md (owner answer D3) ANY active category may be chosen: the options are the
// catalog's active categories, and the sales_goal_monthly_bill_categories_known trigger (0048)
// is the backstop against an unknown code.

export const MONTHLY_BILLS_MESSAGES = {
  invalid: "Pilih kategori dari daftar.",
} as const;

/** Server-side validation of the form's value against `options` (the active category codes, in
 * display order): only offered categories, no duplicates, stored in display order so the same
 * choice always saves the same array. Null when anything is off. */
export function parseMonthlyBillCategories(input: unknown, options: readonly string[]): BusinessExpenseCategory[] | null {
  if (!Array.isArray(input) || input.length > options.length * 2) return null;
  const chosen = new Set<string>();
  for (const value of input) {
    if (typeof value !== "string" || !options.includes(value)) return null;
    chosen.add(value);
  }
  return options.filter((category) => chosen.has(category));
}

/** The chosen categories; [] (off) when the row is missing. */
export async function getMonthlyBillCategories(db: Database = defaultDb): Promise<BusinessExpenseCategory[]> {
  const [row] = await db.select({ categories: salesGoal.monthlyBillCategories }).from(salesGoal).where(eq(salesGoal.id, 1));
  return row?.categories ?? [];
}

/** Input is already validated (parseMonthlyBillCategories). An upsert like saveSalesGoal: a
 * database that lost row 1 gets it back (with the column defaults for the goal). The `before` read
 * locks the row, so two concurrent saves write two audit rows in order. */
export async function saveMonthlyBillCategories(categories: readonly BusinessExpenseCategory[], actorStaffUserId: string | null, db: Database = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx.select({ monthlyBillCategories: salesGoal.monthlyBillCategories }).from(salesGoal).where(eq(salesGoal.id, 1)).for("update");
    const [after] = await tx
      .insert(salesGoal)
      .values({ id: 1, monthlyBillCategories: [...categories] })
      .onConflictDoUpdate({ target: salesGoal.id, set: { monthlyBillCategories: [...categories] } })
      .returning({ monthlyBillCategories: salesGoal.monthlyBillCategories });
    if (!after) throw new Error("failed to save the monthly bills reminder");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "update",
      entityType: "monthly_bills_reminder",
      entityId: "1",
      before: before ?? null,
      after,
    });
  });
}
