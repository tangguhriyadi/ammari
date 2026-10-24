import "server-only";
import { sql } from "drizzle-orm";
import { customers, orders } from "@ammari/db/schema";

/** "Pelanggan" for an order row (owner request after the 2026-10-21 sandbox run): a web checkout
 * order (`payment_status` set) shows the name the buyer typed at checkout, the order's own
 * recipient name, because the linked `customers` row may carry a placeholder ("Pelanggan Ammari")
 * that an unverified guest checkout never overwrites (plan §5 step 4). Manual and marketplace
 * orders keep the customer's name. Needs `customers` left-joined on `orders.customer_id`. */
export function orderBuyerNameSql() {
  return sql<string | null>`case when ${orders.paymentStatus} is not null then coalesce(nullif(btrim(${orders.recipientName}), ''), ${customers.name}) else ${customers.name} end`;
}

/** The same rule for a hand-written query that aliases orders as `o` and customers as `cu`. */
export function aliasedOrderBuyerNameSql() {
  return sql<string | null>`case when o.payment_status is not null then coalesce(nullif(btrim(o.recipient_name), ''), cu.name) else cu.name end`;
}
