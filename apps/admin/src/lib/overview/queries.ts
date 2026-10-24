import "server-only";
import { eq, sql, type SQL } from "drizzle-orm";
import { channels, orderItems, orders, products, productTypes, productVariants, salesGoal } from "@ammari/db/schema";
import { addCalendarDays, jakartaDate, jakartaMidnight } from "@ammari/commerce/jakarta-day";
import { defaultDb, type Database } from "@/lib/db";
import { computeGoalProgress, goalWindow, type GoalProgress, type SalesGoal } from "./goal";
import type { TimeRange } from "./period";
import { countedOrderSql, lineHppSql, orderOmzetSql } from "./revenue-sql";

// Ringkasan aggregations (docs/plans/dashboard-overview.md §1, §3, §4, §7). Every money figure is
// cost/profit-adjacent data (D9): with `canViewProfit = false` it is not selected at all, so it can
// never reach a page payload, and the field is `null`. Callers pass the session's
// finance.view_profit, never a UI flag.

export interface ProfitOption {
  canViewProfit: boolean;
}

/** Window of "recent" sales for the average price per piece in the target tracker. */
const RECENT_DAYS = 30;

function toAmount(value: string | number | null | undefined): number {
  const amount = Number(value ?? 0);
  if (!Number.isSafeInteger(amount)) throw new Error("overview amount overflow");
  return amount;
}

/** `o.order_date` within a half-open range, as instants so orders_order_date_idx is used. */
function orderDateInRangeSql(range: TimeRange): SQL {
  return sql`o.order_date >= ${range.start.toISOString()}::timestamptz and o.order_date < ${range.end.toISOString()}::timestamptz`;
}

/** The counted orders of a range as a CTE body (`id`, `channel_id`, and `omzet` when allowed). */
function countedOrdersCte(range: TimeRange, canViewProfit: boolean): SQL {
  return sql`select o.id, o.channel_id${canViewProfit ? sql`, ${orderOmzetSql()} as omzet` : sql``}
    from ${orders} o
    where ${orderDateInRangeSql(range)} and ${countedOrderSql()}`;
}

// ---------- KPI tiles ----------

export interface PeriodMoney {
  omzet: number;
  hpp: number;
  labaKotor: number;
  /** laba kotor / omzet; null without omzet. */
  marginBps: number | null;
  /** omzet / orders, rounded; null without orders. */
  averageOrderAmount: number | null;
  /** Counted lines whose locked unit_cost is 0 (their stock had no value): HPP is incomplete. */
  linesWithoutCost: number;
}

export interface PeriodTotals {
  orders: number;
  pcs: number;
  /** By order date, for the "Batal: N, Retur: N" line; never part of the counts above. */
  cancelledOrders: number;
  returnedOrders: number;
  money: PeriodMoney | null;
}

type PeriodTotalsRow = {
  orders: number;
  pcs: string;
  cancelled_orders: number;
  returned_orders: number;
  omzet?: string;
  hpp?: string;
  lines_without_cost?: number;
};

export async function getPeriodTotals(range: TimeRange, { canViewProfit }: ProfitOption, db: Database = defaultDb): Promise<PeriodTotals> {
  const [row] = await db.execute<PeriodTotalsRow>(sql`
    with counted as (${countedOrdersCte(range, canViewProfit)}),
    lines as (
      select sum(oi.qty)::bigint as pcs
        ${canViewProfit ? sql`, sum(${lineHppSql()})::bigint as hpp, count(*) filter (where oi.unit_cost = 0)::int as lines_without_cost` : sql``}
      from ${orderItems} oi
      join counted c on c.id = oi.order_id
    ),
    undone as (
      select count(*) filter (where o.status = 'cancelled')::int as cancelled_orders,
             count(*) filter (where o.status = 'returned')::int as returned_orders
      from ${orders} o
      where ${orderDateInRangeSql(range)} and o.status in ('cancelled', 'returned')
    )
    select (select count(*) from counted)::int as orders,
           coalesce(lines.pcs, 0)::text as pcs,
           undone.cancelled_orders,
           undone.returned_orders
           ${
             canViewProfit
               ? sql`, (select coalesce(sum(counted.omzet), 0) from counted)::text as omzet,
                  coalesce(lines.hpp, 0)::text as hpp,
                  coalesce(lines.lines_without_cost, 0) as lines_without_cost`
               : sql``
           }
    from lines, undone
  `);
  if (!row) throw new Error("period totals query returned no row");

  const totals = { orders: row.orders, pcs: toAmount(row.pcs), cancelledOrders: row.cancelled_orders, returnedOrders: row.returned_orders };
  if (!canViewProfit) return { ...totals, money: null };
  const omzet = toAmount(row.omzet);
  const hpp = toAmount(row.hpp);
  const labaKotor = omzet - hpp;
  return {
    ...totals,
    money: {
      omzet,
      hpp,
      labaKotor,
      marginBps: omzet > 0 ? Math.round((labaKotor * 10_000) / omzet) : null,
      averageOrderAmount: totals.orders > 0 ? Math.round(omzet / totals.orders) : null,
      linesWithoutCost: row.lines_without_cost ?? 0,
    },
  };
}

// ---------- Breakdowns ----------

export interface ChannelBreakdownRow {
  channelId: string;
  channelName: string;
  orders: number;
  pcs: number;
  omzet: number | null;
}

type ChannelRow = { channel_id: string; channel_name: string; orders: number; pcs: string; omzet?: string };

/** Per channel, from the order header, so it sums exactly to the omzet tile. Biggest first (by
 * omzet, or by orders without finance.view_profit). */
export async function getChannelBreakdown(range: TimeRange, { canViewProfit }: ProfitOption, db: Database = defaultDb): Promise<ChannelBreakdownRow[]> {
  const rows = await db.execute<ChannelRow>(sql`
    with counted as (${countedOrdersCte(range, canViewProfit)}),
    order_pcs as (
      select oi.order_id, sum(oi.qty)::bigint as pcs
      from ${orderItems} oi
      join counted c on c.id = oi.order_id
      group by oi.order_id
    )
    select c.channel_id, ch.name as channel_name, count(*)::int as orders, coalesce(sum(order_pcs.pcs), 0)::text as pcs
           ${canViewProfit ? sql`, sum(c.omzet)::text as omzet` : sql``}
    from counted c
    join ${channels} ch on ch.id = c.channel_id
    left join order_pcs on order_pcs.order_id = c.id
    group by c.channel_id, ch.name
    order by ${canViewProfit ? sql`sum(c.omzet) desc,` : sql``} count(*) desc, c.channel_id
  `);
  return rows.map((row) => ({
    channelId: row.channel_id,
    channelName: row.channel_name,
    orders: row.orders,
    pcs: toAmount(row.pcs),
    omzet: canViewProfit ? toAmount(row.omzet) : null,
  }));
}

export interface ProductTypeBreakdownRow {
  productTypeCode: string;
  productTypeName: string;
  pcs: number;
  omzet: number | null;
}

type ProductTypeRow = { product_type_code: string; product_type_name: string; pcs: string; omzet?: string };

/**
 * Per product type. Omzet is per order, but a type is per line, so each counted order's omzet
 * (voucher and partial refund included) is spread over its lines by their share of the order's
 * goods value (D6): floor for every line, and the order's last line (by id) takes the remainder.
 * The rows therefore add up to the omzet tile to the rupiah. An order whose lines are all Rp 0
 * gives its whole omzet to its last line.
 */
export async function getProductTypeBreakdown(
  range: TimeRange,
  { canViewProfit }: ProfitOption,
  db: Database = defaultDb,
): Promise<ProductTypeBreakdownRow[]> {
  const typedLines = sql`
    from ${orderItems} oi
    join counted c on c.id = oi.order_id
    join ${productVariants} v on v.sku = oi.sku
    join ${products} p on p.id = v.product_id`;

  const rows = canViewProfit
    ? await db.execute<ProductTypeRow>(sql`
        with counted as (${countedOrdersCte(range, true)}),
        lines as (
          select oi.order_id, oi.qty, p.product_type_code, c.omzet,
                 oi.qty::numeric * oi.unit_price as gross,
                 sum(oi.qty::numeric * oi.unit_price) over by_order as order_gross,
                 row_number() over (partition by oi.order_id order by oi.id desc) = 1 as is_last
          ${typedLines}
          window by_order as (partition by oi.order_id)
        ),
        shares as (
          select lines.*,
                 case when order_gross = 0 then 0 else floor(omzet * gross / order_gross) end as floor_share
          from lines
        ),
        allocated as (
          select product_type_code, qty,
                 case when is_last then omzet - (sum(floor_share) over (partition by order_id) - floor_share) else floor_share end as line_omzet
          from shares
        )
        select t.code as product_type_code, t.name::text as product_type_name,
               sum(allocated.qty)::text as pcs, sum(allocated.line_omzet)::bigint::text as omzet
        from allocated
        join ${productTypes} t on t.code = allocated.product_type_code
        group by t.code, t.name
        order by sum(allocated.line_omzet) desc, t.code
      `)
    : await db.execute<ProductTypeRow>(sql`
        with counted as (${countedOrdersCte(range, false)})
        select t.code as product_type_code, t.name::text as product_type_name, sum(oi.qty)::text as pcs
        ${typedLines}
        join ${productTypes} t on t.code = p.product_type_code
        group by t.code, t.name
        order by sum(oi.qty) desc, t.code
      `);

  return rows.map((row) => ({
    productTypeCode: row.product_type_code,
    productTypeName: row.product_type_name,
    pcs: toAmount(row.pcs),
    omzet: canViewProfit ? toAmount(row.omzet) : null,
  }));
}

// ---------- Target tracker ----------

/** The one sales_goal row (migration 0039), or null if it is missing. */
export async function getSalesGoal(db: Database = defaultDb): Promise<SalesGoal | null> {
  const [row] = await db
    .select({ revenueTargetAmount: salesGoal.revenueTargetAmount, startDate: salesGoal.startDate })
    .from(salesGoal)
    .where(eq(salesGoal.id, 1));
  return row ?? null;
}

/** First-year progress (§2.3). Null without finance.view_profit: with the target known, even the
 * percentage reveals revenue (D9). */
export async function getGoalProgress(
  { canViewProfit, now = new Date() }: ProfitOption & { now?: Date },
  db: Database = defaultDb,
): Promise<GoalProgress | null> {
  if (!canViewProfit) return null;
  const goal = await getSalesGoal(db);
  const window = goal ? goalWindow(goal) : null;
  if (!goal || !window) return { state: "not_configured" };

  const today = jakartaDate(now);
  const goalStart = jakartaMidnight(window.startDate);
  if (goalStart.getTime() > now.getTime()) return computeGoalProgress(goal, today, 0, { omzet: 0, pcs: 0 });

  const goalEnd = new Date(Math.min(jakartaMidnight(addCalendarDays(window.endDate, 1)).getTime(), now.getTime()));
  const [toDate, recent] = await Promise.all([
    getPeriodTotals({ start: goalStart, end: goalEnd }, { canViewProfit: true }, db),
    getPeriodTotals({ start: jakartaMidnight(addCalendarDays(today, -(RECENT_DAYS - 1))), end: now }, { canViewProfit: true }, db),
  ]);
  if (!toDate.money || !recent.money) throw new Error("goal progress needs the money totals");
  return computeGoalProgress(goal, today, toDate.money.omzet, { omzet: recent.money.omzet, pcs: recent.pcs });
}
