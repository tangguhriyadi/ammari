import "server-only";
import { sql } from "drizzle-orm";
import { resolveReportRange, type ReportRange } from "@ammari/accounting";
import { businessExpenses, orderItems, orders, type AccountType } from "@ammari/db/schema";
import { defaultDb, type Database } from "@/lib/db";
import { dateRangeToTimeRange } from "@/lib/expenses/summary";
import { countedOrderSql, lineHppSql, orderOmzetSql, orderPlatformFeeSql, orderWebShippingSubsidySql } from "@/lib/overview/revenue-sql";
import type { DateRange } from "./filters";
import {
  COMPONENT_KEY_KIND,
  COMPONENT_PROFIT_SIGN,
  componentOfAccount,
  PNL_COMPONENTS,
  reconcileComponent,
  type ComponentReconciliation,
  type PnlComponent,
} from "./pnl-reconciliation-rules";
import { IS_CLOSING_SQL, IS_OPENING_SQL } from "./trial-balance";

// Rekonsiliasi check 4 (docs/plans/accounting.md §6.3, Session 10): the ledger's Laba rugi against
// the management P&L for the same range. The management side is built from the SAME SQL fragments
// as Ringkasan and the Biaya tab (lib/overview/revenue-sql.ts: counted orders by order_date, omzet
// after voucher and partial refund, HPP qty × unit_cost, order_channel_fees, web shipping subsidy;
// non-voided business_expenses by expense_date), per order and per expense, so each difference is
// matched to its cause: revenue timing (order date vs ship date), refunds and returns, accrual vs
// cash expenses, figures the management P&L does not have at all (stock adjustments, defects,
// production variance, depreciation, MDR, PPh), and entries before the books started.

export interface PnlReconciliation {
  range: ReportRange;
  components: ComponentReconciliation[];
  managementNet: number;
  ledgerNet: number;
  /** Order number per order id and expense number per expense id, for the sample links. */
  labels: Record<string, string>;
}

function num(value: string | number | null | undefined): number {
  const amount = Number(value ?? 0);
  // A report never prints a rounded figure.
  if (!Number.isSafeInteger(amount)) throw new Error("accounting report amount overflow");
  return amount;
}


export async function getPnlReconciliation(requested: DateRange, db: Database = defaultDb, now: Date = new Date()): Promise<PnlReconciliation> {
  const range = resolveReportRange(requested);
  const time = dateRangeToTimeRange(range, now);

  const [accountRows, ledgerRows, orderRows, expenseRows] = await Promise.all([
    db.execute(sql`select code, type, system_key, parent_code, is_header from accounts`) as unknown as Promise<
      { code: string; type: AccountType; system_key: string | null; parent_code: string | null; is_header: boolean }[]
    >,
    db.execute(sql`
      select l.account_code, l.order_id::text as order_id,
        case when e.source_type = 'business_expense' then e.source_id end as expense_id,
        sum(l.debit - l.credit)::bigint as net
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      left join journal_entries reversed on reversed.id = e.reverses_entry_id
      join accounts a on a.code = l.account_code
      where e.entry_date >= ${range.from} and e.entry_date <= ${range.to} and not ${IS_OPENING_SQL} and not ${IS_CLOSING_SQL}
        and a.type in ('revenue', 'contra_revenue', 'cogs', 'expense', 'other_income', 'other_expense', 'tax')
      group by 1, 2, 3
    `) as unknown as Promise<{ account_code: string; order_id: string | null; expense_id: string | null; net: string }[]>,
    db.execute(sql`
      select o.id::text as id, o.order_no,
        ${orderOmzetSql()} as omzet,
        coalesce((select sum(${lineHppSql()}) from ${orderItems} oi where oi.order_id = o.id), 0) as hpp,
        ${orderPlatformFeeSql()} as platform_fee,
        ${orderWebShippingSubsidySql()} as shipping_subsidy
      from ${orders} o
      where o.order_date >= ${time.start.toISOString()}::timestamptz and o.order_date < ${time.end.toISOString()}::timestamptz and ${countedOrderSql()}
    `) as unknown as Promise<{ id: string; order_no: string; omzet: string; hpp: string; platform_fee: string; shipping_subsidy: string }[]>,
    db.execute(sql`
      select x.id::text as id, x.expense_no, x.amount
      from ${businessExpenses} x
      where x.voided_at is null and x.expense_date >= ${range.from} and x.expense_date <= ${range.to}
    `) as unknown as Promise<{ id: string; expense_no: string; amount: string }[]>,
  ]);

  // Headers whose every system child is a Beban persediaan account (6-4000): a new sub-account there is too.
  const inventoryHeaders = new Set(accountRows.filter((row) => row.system_key === "expense.inventory_variance" && row.parent_code).map((row) => row.parent_code!));
  const componentByAccount = new Map<string, PnlComponent>();
  for (const row of accountRows) {
    if (row.is_header) continue;
    const component = componentOfAccount({ code: row.code, type: row.type, systemKey: row.system_key, parentCode: row.parent_code }, inventoryHeaders);
    if (component) componentByAccount.set(row.code, component);
  }

  const management = Object.fromEntries(PNL_COMPONENTS.map((component) => [component, new Map<string, number>()])) as Record<PnlComponent, Map<string, number>>;
  const labels: Record<string, string> = {};
  const put = (component: PnlComponent, key: string, value: number) => {
    if (value !== 0) management[component].set(key, (management[component].get(key) ?? 0) + value);
  };
  for (const row of orderRows) {
    labels[row.id] = row.order_no;
    put("net_sales", row.id, num(row.omzet));
    put("cogs", row.id, num(row.hpp));
    put("platform_fees", row.id, num(row.platform_fee));
    put("shipping", row.id, num(row.shipping_subsidy));
  }
  for (const row of expenseRows) {
    labels[row.id] = row.expense_no;
    put("operating_expenses", row.id, num(row.amount));
  }

  const ledgerByKey = Object.fromEntries(PNL_COMPONENTS.map((component) => [component, new Map<string, number>()])) as Record<PnlComponent, Map<string, number>>;
  const outside = Object.fromEntries(PNL_COMPONENTS.map((component) => [component, 0])) as Record<PnlComponent, number>;
  for (const row of ledgerRows) {
    const component = componentByAccount.get(row.account_code);
    if (!component) continue;
    // On the component's own side: sales and other income as credit − debit, costs as debit − credit.
    const value = COMPONENT_PROFIT_SIGN[component] === 1 ? -num(row.net) : num(row.net);
    const kind = COMPONENT_KEY_KIND[component];
    const key = kind === "order" ? row.order_id : kind === "expense" ? row.expense_id : null;
    if (key) ledgerByKey[component].set(key, (ledgerByKey[component].get(key) ?? 0) + value);
    else outside[component] += value;
  }

  const components = PNL_COMPONENTS.map((component) => reconcileComponent({ component, management: management[component], ledgerByKey: ledgerByKey[component], ledgerOutside: outside[component] }));
  const net = (pick: (row: ComponentReconciliation) => number) => components.reduce((sum, row) => sum + COMPONENT_PROFIT_SIGN[row.component] * pick(row), 0);

  // Labels for ledger-only orders and expenses too (not in the management query).
  const missing = [...new Set(components.flatMap((row) => row.lines.flatMap((line) => line.sampleKeys)).filter((key) => !(key in labels)))];
  if (missing.length > 0) {
    const extra = (await db.execute(sql`
      select id::text as id, order_no as label from ${orders} where id in (${sql.join(missing.map((id) => sql`${id}::uuid`), sql`, `)})
      union all
      select id::text, expense_no from ${businessExpenses} where id in (${sql.join(missing.map((id) => sql`${id}::uuid`), sql`, `)})
    `)) as unknown as { id: string; label: string }[];
    for (const row of extra) labels[row.id] = row.label;
  }

  return { range, components, managementNet: net((row) => row.management), ledgerNet: net((row) => row.ledger), labels };
}
