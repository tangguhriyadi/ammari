import "server-only";
import { and, asc, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { fabricColors, orderAccessTokens, orderItems, orders, payments, products, productVariants, vouchers } from "@ammari/db/schema";
import { hashOrderAccessToken, isWellFormedOrderAccessToken } from "@ammari/commerce/checkout";
import { defaultDb, type Database } from "@/lib/db";
import { formatJakartaDate, formatJakartaDateTime } from "@/lib/format";
import type { CheckoutVoucherOption } from "./form";

// Reads for the checkout and finish pages (docs/plans/cart-checkout.md §4.3, §4.4, session 10).
// Customer-facing: no cost column is ever selected (order_items.unit_cost stays out), and nothing
// here returns a stock number.

/** The session customer's vouchers that placeOrder would accept right now (`active`, not expired),
 * best first (plan §4.3: largest amount, then soonest expiry), so the first one is the
 * auto-selected choice. placeOrder re-checks the voucher atomically; this only fills the dropdown. */
export async function listUsableVouchers(customerId: string, db: Database = defaultDb): Promise<CheckoutVoucherOption[]> {
  const rows = await db
    .select({ id: vouchers.id, amount: vouchers.amount, expiresAt: vouchers.expiresAt })
    .from(vouchers)
    .where(and(eq(vouchers.customerId, customerId), eq(vouchers.status, "active"), gt(vouchers.expiresAt, sql`now()`)))
    .orderBy(desc(vouchers.amount), asc(vouchers.expiresAt), asc(vouchers.id));
  return rows.map((row) => ({ id: row.id, amount: row.amount, expiresOn: formatJakartaDate(row.expiresAt) }));
}

/** `paid`: a verified notification marked it paid. `pending`: still inside the payment window.
 * `confirming`: past the window but not finalized yet (a payment made at the last minute may still
 * be confirmed; the expiry sweep or a notification decides). `failed`: cancelled, expired or the
 * payment failed. */
export type FinishState = "paid" | "pending" | "confirming" | "failed";

export interface FinishOrderLine {
  name: string;
  variant: string;
  qty: number;
  lineTotal: number;
}

export interface FinishOrderView {
  orderNo: string;
  state: FinishState;
  /** Placed without a session: the page offers "Masuk untuk melihat semua pesanan". */
  isGuestOrder: boolean;
  /** For the login prefill of a guest order only; null otherwise. */
  guestContactEmail: string | null;
  lines: FinishOrderLine[];
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
  courierLabel: string | null;
  /** "21 Oktober 2026, 14.30 WIB", only while pending. */
  payBy: string | null;
  /** The stored payment page, only while pending; null when it could not be created. */
  paymentUrl: string | null;
}

const ORDER_NO_PATTERN = /^ORD-[0-9]{6}-[0-9]{4,}$/;

function sizeLabel(size: string): string {
  return size === "ALLSIZE" ? "All Size" : size;
}

function finishState(order: { orderNo: string; status: string; paymentStatus: string | null; stillPayable: boolean }): FinishState {
  if (order.paymentStatus === "paid") return "paid";
  if (order.status === "awaiting_payment" && order.paymentStatus === "pending") return order.stillPayable ? "pending" : "confirming";
  if (order.status === "cancelled" || order.paymentStatus === "expired" || order.paymentStatus === "cancelled") return "failed";
  // Refunds, chargebacks or an order staff moved on: nothing the finish page has words for yet.
  console.warn("[checkout] finish page: unexpected order state", { orderNo: order.orderNo, status: order.status, paymentStatus: order.paymentStatus });
  return "failed";
}

/** The finish page's order (plan §4.4), or null for anything the visitor may not see: not a
 * checkout order, unknown, or neither proof of ownership holds. Proof is either the session
 * customer who placed it while logged in, or the checkout's order access cookie (its token's
 * sha256 matches an unexpired `order_access_tokens` row of this order). A guest order that only
 * got linked to a customer by its unverified email is not shown to that customer's session here
 * (session 15 decides how "Pesanan saya" treats those). The same null for every case, so the page
 * shows the same "log in to see it" answer and never confirms that an order number exists. The state comes from our
 * own database only (a provider status check arrives with the real provider, session 11). */
export async function loadFinishOrder(
  params: { orderNo: string; sessionCustomerId: string | null; accessToken: string | null },
  db: Database = defaultDb,
): Promise<FinishOrderView | null> {
  if (!ORDER_NO_PATTERN.test(params.orderNo)) return null;

  const [order] = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      paymentExpiresAt: orders.paymentExpiresAt,
      customerId: orders.customerId,
      placedWithSession: orders.placedWithSession,
      contactEmail: orders.contactEmail,
      subtotal: orders.subtotalAmount,
      shipping: orders.shippingAmount,
      discount: orders.discountAmount,
      total: orders.totalAmount,
      courierLabel: orders.shippingCourierLabel,
      stillPayable: sql<boolean>`${orders.paymentExpiresAt} > now()`,
    })
    .from(orders)
    .where(and(eq(orders.orderNo, params.orderNo), isNotNull(orders.paymentStatus)))
    .limit(1);
  if (!order) return null;

  const ownsBySession = params.sessionCustomerId !== null && order.placedWithSession === true && order.customerId === params.sessionCustomerId;
  let ownsByToken = false;
  if (!ownsBySession && params.accessToken && isWellFormedOrderAccessToken(params.accessToken)) {
    const [match] = await db
      .select({ id: orderAccessTokens.id })
      .from(orderAccessTokens)
      .where(
        and(
          eq(orderAccessTokens.orderId, order.id),
          eq(orderAccessTokens.tokenHash, hashOrderAccessToken(params.accessToken)),
          sql`${orderAccessTokens.expiresAt} > now()`,
        ),
      )
      .limit(1);
    ownsByToken = match !== undefined;
  }
  if (!ownsBySession && !ownsByToken) return null;

  const state = finishState(order);

  const items = await db
    .select({
      productName: products.name,
      colorName: fabricColors.name,
      size: productVariants.size,
      qty: orderItems.qty,
      unitPrice: orderItems.unitPrice,
    })
    .from(orderItems)
    .innerJoin(productVariants, eq(productVariants.sku, orderItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.sku));

  // The lines must add up to the stored subtotal; a line lost by a join would show an order that
  // does not add up, so it is logged loudly (the totals shown stay the stored ones).
  const linesTotal = items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
  if (linesTotal !== order.subtotal) {
    console.error("[checkout] finish page lines do not add up to the order subtotal", { orderNo: order.orderNo, lines: items.length });
  }

  let paymentUrl: string | null = null;
  if (state === "pending") {
    const [payment] = await db
      .select({ attempt: payments.attempt, redirectUrl: payments.redirectUrl })
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .orderBy(desc(payments.attempt))
      .limit(1);
    paymentUrl = payment?.redirectUrl ?? null;
    // The payment page could not be created (placeOrder logged the provider failure) or the row is
    // missing: the buyer sees a retry message, the log names the order.
    if (!paymentUrl) console.warn("[checkout] finish page: pending order without a payment page", { orderNo: order.orderNo, attempt: payment?.attempt ?? null });
  }

  const isGuestOrder = order.placedWithSession === false;
  return {
    orderNo: order.orderNo,
    state,
    isGuestOrder,
    guestContactEmail: isGuestOrder ? (order.contactEmail ?? null) : null,
    lines: items.map((item) => ({
      name: item.productName,
      variant: `${item.colorName} · ${sizeLabel(item.size)}`,
      qty: item.qty,
      lineTotal: item.qty * item.unitPrice,
    })),
    subtotal: order.subtotal,
    shipping: order.shipping,
    discount: order.discount,
    total: order.total,
    courierLabel: order.courierLabel,
    payBy: state === "pending" && order.paymentExpiresAt ? formatJakartaDateTime(order.paymentExpiresAt) : null,
    paymentUrl,
  };
}
