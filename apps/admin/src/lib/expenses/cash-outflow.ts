import "server-only";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { businessExpenses, expenseCategories } from "@ammari/db/schema";
import { defaultDb, type Database } from "@/lib/db";
import { sumCashOutflow, type CashOutflow } from "./cash-outflow-sum";
import { monthRange } from "./figures";
import { getProductionOutflowTotal } from "./production-outflows";

// "Arus kas keluar" at the top of Biaya (docs/plans/expense-master-data.md §3.10, session S6): the
// money that left the business in one Jakarta month, as CASH FLOW, not profit. Operating and
// ad/endorse expenses by payment date, plus supplier payments by paid date. Payments from the
// Shopee/TikTok seller balance are included (owner answer D10). Imported only by the Biaya page:
// Laba bersih, the P&L and the reports never read this (§3.11). The caller has checked
// ads_expenses.manage + finance.view_profit.

function toAmount(value: string | null | undefined): number {
  const amount = Number(value ?? 0);
  if (!Number.isSafeInteger(amount)) throw new Error("cash outflow overflow");
  return amount;
}

export async function getCashOutflow(month: string, db: Database = defaultDb): Promise<CashOutflow> {
  const range = monthRange(month);
  const [[expenses], production] = await Promise.all([
    db
      .select({
        operating: sql<string>`coalesce(sum(${businessExpenses.amount}) filter (where ${expenseCategories.kind} = 'operating'), 0)::text`,
        ads: sql<string>`coalesce(sum(${businessExpenses.amount}) filter (where ${expenseCategories.kind} in ('ad', 'endorsement')), 0)::text`,
      })
      .from(businessExpenses)
      .innerJoin(expenseCategories, eq(expenseCategories.code, businessExpenses.category))
      .where(and(isNull(businessExpenses.voidedAt), gte(businessExpenses.expenseDate, range.from), lte(businessExpenses.expenseDate, range.to))),
    getProductionOutflowTotal(range, db),
  ]);
  return sumCashOutflow({ operating: toAmount(expenses?.operating), production, ads: toAmount(expenses?.ads) });
}
