import "server-only";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { customers, orderAccessTokens, orders } from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";
import { hashOrderAccessToken, isWellFormedOrderAccessToken } from "@ammari/commerce/checkout";
import { defaultDb, type Database } from "@/lib/db";

// Who may see an order on the storefront (docs/plans/cart-checkout.md §9.1, §9.2). One rule for
// "Pesanan saya", the order page, the finish page and their actions:
// - a session sees its own orders: staff-entered and marketplace orders linked to it (as before),
//   checkout orders it placed while logged in, and guest checkout orders whose contact email is
//   still the account's email (owner decision 2026-10-21, session 15: the login proved that email,
//   and the order emails already went there, so the list shows nothing the inbox does not). A
//   guest order typed with an email the account no longer has stays out;
// - a browser holding an order access token for that one order (the "Lihat pesanan" cookie, or the
//   checkout's own cookie on the finish page) sees that order only, while the token is unexpired.

export const ORDER_NO_PATTERN = /^ORD-[0-9]{6}-[0-9]{4,}$/;

export function isOrderNo(value: unknown): value is string {
  return typeof value === "string" && ORDER_NO_PATTERN.test(value);
}

/** The orders a session customer may see (a WHERE condition on `orders`). The account's email is
 * read in the same statement, never taken from the caller. */
export function visibleToCustomerSql(customerId: string): SQL {
  // Only a verified email (every login stamps it); defence in depth should any later flow ever let
  // an account hold an email it has not proved (security review, session 15).
  const accountEmail = sql`(select ${qualifiedColumn(customers, customers.email)} from ${customers} where ${qualifiedColumn(customers, customers.id)} = ${customerId} and ${qualifiedColumn(customers, customers.emailVerifiedAt)} is not null)`;
  const condition = and(
    eq(orders.customerId, customerId),
    or(isNull(orders.paymentStatus), eq(orders.placedWithSession, true), sql`${qualifiedColumn(orders, orders.contactEmail)} = ${accountEmail}`),
  );
  if (!condition) throw new Error("visibility condition is empty");
  return condition;
}

export type OrderAccess = { orderId: string; via: "session" | "token" };

/** The order `orderNo` if this visitor may see it, otherwise null for every case alike (unknown
 * number, someone else's order, wrong or expired token), so no caller can tell them apart.
 * `accessTokens` are the raw tokens the browser's cookies carry; each is only ever compared by
 * its sha256 against that order's own rows. */
export async function findAccessibleOrder(
  params: { orderNo: string; sessionCustomerId: string | null; accessTokens: readonly (string | null | undefined)[] },
  db: Database = defaultDb,
): Promise<OrderAccess | null> {
  if (!isOrderNo(params.orderNo)) return null;
  const visible = params.sessionCustomerId ? visibleToCustomerSql(params.sessionCustomerId) : sql`false`;
  const [order] = await db
    .select({ id: orders.id, visibleToSession: sql<boolean>`coalesce(${visible}, false)` })
    .from(orders)
    .where(eq(orders.orderNo, params.orderNo))
    .limit(1);
  if (!order) return null;
  if (order.visibleToSession) return { orderId: order.id, via: "session" };

  const hashes = [...new Set(params.accessTokens.filter((token): token is string => typeof token === "string" && isWellFormedOrderAccessToken(token)))].map(hashOrderAccessToken);
  for (const tokenHash of hashes) {
    const [match] = await db
      .select({ id: orderAccessTokens.id })
      .from(orderAccessTokens)
      .where(and(eq(orderAccessTokens.orderId, order.id), eq(orderAccessTokens.tokenHash, tokenHash), sql`${orderAccessTokens.expiresAt} > now()`))
      .limit(1);
    if (match) return { orderId: order.id, via: "token" };
  }
  return null;
}

/** The "Lihat pesanan" link's token for `orderNo` (plan §9.2): when it is one of that order's
 * unexpired tokens, marks it used and returns when it expires (the cookie's lifetime); otherwise
 * null. One statement, by hash only. */
export async function redeemOrderViewToken(orderNo: string, token: string, db: Database = defaultDb): Promise<{ expiresAt: Date } | null> {
  if (!isOrderNo(orderNo) || !isWellFormedOrderAccessToken(token)) return null;
  const [row] = await db
    .update(orderAccessTokens)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(orderAccessTokens.tokenHash, hashOrderAccessToken(token)),
        sql`${orderAccessTokens.expiresAt} > now()`,
        sql`${qualifiedColumn(orderAccessTokens, orderAccessTokens.orderId)} = (select ${qualifiedColumn(orders, orders.id)} from ${orders} where ${qualifiedColumn(orders, orders.orderNo)} = ${orderNo})`,
      ),
    )
    .returning({ expiresAt: orderAccessTokens.expiresAt });
  return row ?? null;
}
