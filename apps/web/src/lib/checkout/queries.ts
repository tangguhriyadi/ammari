import "server-only";
import { and, asc, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { fabricColors, orderItems, orders, payments, products, productVariants, vouchers } from "@ammari/db/schema";
import { findAccessibleOrder, ORDER_NO_PATTERN } from "@/lib/orders/access";
import { defaultDb, type Database } from "@/lib/db";
import { formatJakartaDate, formatJakartaDateTime } from "@/lib/format";
import type { CheckoutVoucherOption } from "./form";

// Reads for the checkout and finish pages (docs/plans/cart-checkout.md §4.3, §4.4).
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

/** `paid`: a verified notification (or the page's status check) marked it paid. `pending`: still inside the payment window.
 * `confirming`: past the window but not finalized yet (a payment made at the last minute may still
 * be confirmed; the expiry sweep or a notification decides). `failed`: cancelled, expired or the
 * payment failed. `refund_pending`: paid after the order had already been cancelled. */
export type FinishState = "paid" | "pending" | "confirming" | "failed" | "refund_pending";

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

function sizeLabel(size: string): string {
  return size === "ALLSIZE" ? "All Size" : size;
}

function finishState(order: { orderNo: string; status: string; paymentStatus: string | null; stillPayable: boolean }): FinishState {
  // Paid after the order was cancelled (the window ran out first): the money goes back (plan §6.2,
  // flagged paid_after_cancel + refund_due for staff).
  if (order.status === "cancelled" && order.paymentStatus === "paid") return "refund_pending";
  if (order.paymentStatus === "paid") return "paid";
  if (order.status === "awaiting_payment" && order.paymentStatus === "pending") return order.stillPayable ? "pending" : "confirming";
  if (order.status === "cancelled" || order.paymentStatus === "expired" || order.paymentStatus === "cancelled") return "failed";
  // Refunds, chargebacks or an order staff moved on: nothing the finish page has words for yet.
  console.warn("[checkout] finish page: unexpected order state", { orderNo: order.orderNo, status: order.status, paymentStatus: order.paymentStatus });
  return "failed";
}

/** Who may see a checkout order here: the shared storefront rule (lib/orders/access.ts): the
 * session it belongs to (placed while logged in, or a guest order whose contact email is still the
 * account's email, owner decision 2026-10-21, session 15), or a browser holding one of the order's
 * unexpired access tokens (the checkout's cookie on the finish page, the "Lihat pesanan" cookie on
 * the order page). Shared by the finish page and its payment actions. */
async function ownsCheckoutOrder(db: Database, orderNo: string, params: { sessionCustomerId: string | null; accessTokens: readonly (string | null)[] }): Promise<boolean> {
  return (await findAccessibleOrder({ orderNo, sessionCustomerId: params.sessionCustomerId, accessTokens: params.accessTokens }, db)) !== null;
}

/** The id of the checkout order `orderNo` when the visitor may act on it (the finish page's status
 * check and retry), otherwise null for every case alike. */
export async function findOwnedCheckoutOrderId(
  params: { orderNo: string; sessionCustomerId: string | null; accessTokens: readonly (string | null)[] },
  db: Database = defaultDb,
): Promise<string | null> {
  if (!ORDER_NO_PATTERN.test(params.orderNo)) return null;
  const [order] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.orderNo, params.orderNo), isNotNull(orders.paymentStatus)))
    .limit(1);
  if (!order) return null;
  return (await ownsCheckoutOrder(db, params.orderNo, params)) ? order.id : null;
}

/** The finish page's order (plan §4.4), or null for anything the visitor may not see: not a
 * checkout order, unknown, or neither proof of ownership holds (ownsCheckoutOrder). The same null
 * for every case, so the page shows the same "log in to see it" answer and never confirms that an
 * order number exists. The state comes from our own database; the page's status check
 * (lib/checkout/payment-actions.ts) asks the gateway and refreshes it. */
export async function loadFinishOrder(
  params: { orderNo: string; sessionCustomerId: string | null; accessTokens: readonly (string | null)[] },
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
  if (!(await ownsCheckoutOrder(db, order.orderNo, params))) return null;

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
