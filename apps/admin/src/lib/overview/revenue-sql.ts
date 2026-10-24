import { sql, type SQL } from "drizzle-orm";
import { payments, type OrderPaymentStatus, type OrderStatus } from "@ammari/db/schema";

// The ONE definition of omzet and laba kotor (docs/plans/dashboard-overview.md §1, owner decisions
// D1, D6, D11). Every Ringkasan figure (tiles, target tracker, breakdowns) is built from these
// fragments, so they can never disagree with each other. Each fragment reads the outer query's
// `orders` row through the alias `o`; a query using them must alias orders as `o`.

/** Paid and not undone: stock has left and HPP is locked (D1). `awaiting_payment`, `cancelled`
 * and `returned` are out; a later return drops the order from its original date. */
export const COUNTED_ORDER_STATUSES = ["to_ship", "shipped", "completed"] as const satisfies readonly OrderStatus[];

/** A web checkout order whose whole payment went back (refund or chargeback) never counts, even
 * while its status still says the goods are on their way. */
export const EXCLUDED_ORDER_PAYMENT_STATUSES = ["refunded", "chargeback"] as const satisfies readonly OrderPaymentStatus[];

function textList(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

/** WHERE condition: the order `o` counts toward omzet. Pair it with an `o.order_date` range. */
export function countedOrderSql(): SQL {
  return sql`o.status in (${textList(COUNTED_ORDER_STATUSES)})
    and (o.payment_status is null or o.payment_status not in (${textList(EXCLUDED_ORDER_PAYMENT_STATUSES)}))`;
}

/**
 * One counted order's omzet: goods after voucher, without ongkir (pass-through, SPEC §5.2), minus
 * what was refunded on a partially refunded web order. The refund is capped at the goods amount: a
 * refund can include the buyer's ongkir, which was never omzet. Product discounts are already in
 * `unit_price`, so `subtotal_amount` needs no adjustment. Never below 0: only the total is CHECKed
 * non-negative, so a manual order's discount may exceed its goods (it also covered ongkir), and that
 * extra was never goods revenue to take back. The correlated subquery runs only for a
 * `partially_refunded` order (CASE evaluates it lazily); `payments_order_id_attempt_key` leads with
 * `order_id`, so it is an index lookup.
 */
export function orderOmzetSql(): SQL {
  const goods = sql`greatest(o.subtotal_amount - o.discount_amount, 0)`;
  return sql`(${goods} - case
    when o.payment_status = 'partially_refunded' then least(
      coalesce((select sum(p.refunded_amount) from ${payments} p where p.order_id = o.id), 0),
      ${goods}
    )
    else 0
  end)`;
}

/** One line's HPP; `unit_cost` was locked when the stock left. Alias `oi` for order_items. */
export function lineHppSql(): SQL {
  return sql`(oi.qty::bigint * oi.unit_cost)`;
}
