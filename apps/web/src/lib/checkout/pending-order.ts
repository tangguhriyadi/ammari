import "server-only";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { orderAccessTokens, orderItems, orders, payments, productVariants } from "@ammari/db/schema";
import { hashOrderAccessToken, isWellFormedOrderAccessToken } from "@ammari/commerce/checkout";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { defaultDb, type Database } from "@/lib/db";
import { formatJakartaDateTime } from "@/lib/format";
import { visibleToCustomerSql } from "@/lib/orders/access";
import { readOrderAccessCookie } from "./order-access-cookie";

// "Kamu punya pesanan ORD-... yang menunggu pembayaran" (2026-10-21 sandbox run): a buyer who left
// the payment page with the back button landed on an empty cart and a product that looked sold out
// (the stock was held for their own order). /cart, /checkout and the product pages of the held items
// show their payable order with "Lanjutkan pembayaran" and "Ganti metode pembayaran".
//
// Only the visitor's own order, by the same rule as the finish page: the session's orders
// (lib/orders/access.ts) or the one order the checkout cookie's token names. Never another buyer's,
// and nothing about stock: the product ids say which pages show the banner, never how many pieces.

export interface PendingCheckoutOrder {
  orderNo: string;
  /** "21 Oktober 2026, 14.30 WIB". */
  payBy: string;
  /** The stored payment page, or null when it could not be created ("Buka halaman pembayaran"). */
  paymentUrl: string | null;
  /** The products in the order (product pages show the banner for these only). */
  productIds: string[];
}

/** The newest checkout order of this visitor that is still payable: awaiting payment, payment
 * pending, inside its window. Null for everyone else. */
export async function findPendingCheckoutOrder(
  params: { sessionCustomerId: string | null; accessToken: string | null },
  db: Database = defaultDb,
): Promise<PendingCheckoutOrder | null> {
  const owners = [];
  if (params.sessionCustomerId) owners.push(visibleToCustomerSql(params.sessionCustomerId));
  if (params.accessToken && isWellFormedOrderAccessToken(params.accessToken)) {
    const tokenHash = hashOrderAccessToken(params.accessToken);
    owners.push(
      inArray(
        orders.id,
        db
          .select({ orderId: orderAccessTokens.orderId })
          .from(orderAccessTokens)
          .where(and(eq(orderAccessTokens.tokenHash, tokenHash), sql`${orderAccessTokens.expiresAt} > now()`)),
      ),
    );
  }
  if (owners.length === 0) return null;

  const [order] = await db
    .select({ id: orders.id, orderNo: orders.orderNo, paymentExpiresAt: orders.paymentExpiresAt })
    .from(orders)
    .where(
      and(
        or(...owners),
        eq(orders.status, "awaiting_payment"),
        eq(orders.paymentStatus, "pending"),
        sql`${orders.paymentExpiresAt} > now()`,
      ),
    )
    .orderBy(desc(orders.createdAt))
    .limit(1);
  if (!order?.paymentExpiresAt) return null;

  const [[payment], items] = await Promise.all([
    db.select({ redirectUrl: payments.redirectUrl }).from(payments).where(eq(payments.orderId, order.id)).orderBy(desc(payments.attempt)).limit(1),
    db
      .selectDistinct({ productId: productVariants.productId })
      .from(orderItems)
      .innerJoin(productVariants, eq(productVariants.sku, orderItems.sku))
      .where(eq(orderItems.orderId, order.id)),
  ]);
  const redirectUrl = payment?.redirectUrl ?? null;
  return {
    orderNo: order.orderNo,
    payBy: formatJakartaDateTime(order.paymentExpiresAt),
    // Only an http(s) page, like the finish page's link.
    paymentUrl: redirectUrl && /^https?:\/\//i.test(redirectUrl) ? redirectUrl : null,
    productIds: items.map((item) => item.productId),
  };
}

/** The current request's pending order (session and checkout cookie). A failure to read it hides the
 * banner rather than the page: it is a reminder, never a gate. */
export async function loadPendingCheckoutOrder(): Promise<PendingCheckoutOrder | null> {
  try {
    const [session, accessToken] = await Promise.all([getCustomerSession(), readOrderAccessCookie()]);
    return await findPendingCheckoutOrder({ sessionCustomerId: session?.id ?? null, accessToken });
  } catch (error) {
    // The render Next finishes after the buyer already left for the payment page (placeOrderAction's
    // response) may no longer read request data; that render is thrown away, so it is not an error.
    if (error instanceof Error && error.message.includes("inside `after()`")) {
      console.info("[checkout] pending order not read in a render that runs after the response");
      return null;
    }
    const cause = (error instanceof Error && error.cause !== undefined ? error.cause : error) as { code?: unknown } | null;
    console.error("[checkout] pending order read failed; the page shows no reminder", {
      error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : typeof error,
      code: typeof cause?.code === "string" ? cause.code : null,
    });
    return null;
  }
}
