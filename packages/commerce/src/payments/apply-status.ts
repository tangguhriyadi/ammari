import "server-only";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { orderItems, orders, payments, products, productVariants, stockReservations, type OrderAttentionFlag, type OrderPaymentStatus, type PaymentStatus } from "@ammari/db/schema";
import type { Database, Tx } from "../db";
import { FieldError } from "../errors";
import { transitionOrderStatus } from "../orders/lifecycle";
import type { PaymentStatusReport } from "./provider";
import { isKnownTransactionStatus } from "./status";

// The payment state machine (docs/plans/cart-checkout.md §6.1 step 5, §6.2). Fed only by a status
// the server fetched from the gateway itself (D6): after a notification whose signature verified
// (./notification.ts), or by the finish page's status check (./sync.ts). Never by a notification
// body or a browser redirect.
//
// One transaction: the order row is locked FOR UPDATE first (the same lock every order transition
// takes first), then the payment attempt. Every write is conditional on the state read under
// those locks, so a duplicate, a replay or a late, out-of-order notification is a no-op, and two
// notifications for one order arriving at once serialize on the order lock.
//
// Paid (settlement): the order goes awaiting_payment -> to_ship through transitionOrderStatus with
// no staff actor, which writes the `sale` movements, locks each line's unit_cost at the moving
// average, and consumes the stock holds (owner requirement, session 9 note). When physical stock
// is short by then (an admin adjustment or a marketplace sale took the piece, D4, decision 9) that
// transition is refused inside a savepoint: the payment is still recorded (`payment_status =
// 'paid'`), the order stays awaiting_payment and is flagged `stock_short_at_payment`; staff restock
// and process it, or refund. Expire/cancel of the latest attempt cancels an unpaid order (holds
// released, voucher restored by transitionOrderStatus). Card-only statuses, a `credit_card`
// payment type, a fraud status other than `accept`, an amount or currency that is not the
// attempt's, and unknown statuses are flagged and never mark anything paid.

/** What happened, stored as `payment_notifications.result` and logged. */
export type ApplyOutcome =
  | "paid"
  | "paid_stock_short"
  | "paid_after_cancel"
  | "paid_twice"
  | "pending"
  | "failed"
  | "expired"
  | "cancelled"
  | "refunded"
  | "chargeback"
  | "amount_mismatch"
  | "anomaly"
  | "unknown_status"
  | "unchanged";

export interface ApplyResult {
  outcome: ApplyOutcome;
  orderNo: string;
  /** Products whose availability changed (sale or released holds): their pages need revalidating. */
  productSlugs: string[];
}

const PAID_LIKE: readonly PaymentStatus[] = ["paid", "refunded", "partially_refunded", "chargeback"];
const OPEN: readonly PaymentStatus[] = ["created", "pending", "failed"];
const ORDER_PAID_LIKE: readonly (OrderPaymentStatus | null)[] = ["paid", "refunded", "partially_refunded", "chargeback"];

/** Adds flags to `needs_attention` as a set (adding never removes another; order of first
 * appearance kept; plan §3). */
function withFlags(flags: readonly OrderAttentionFlag[]) {
  const added = sql`array[${sql.join(
    flags.map((flag) => sql`${flag}`),
    sql`, `,
  )}]::text[]`;
  return sql`array(select f from unnest(${orders.needsAttention} || ${added}) with ordinality as t(f, i) group by f order by min(i))`;
}

async function flagOrder(tx: Tx, orderId: string, flags: readonly OrderAttentionFlag[]): Promise<void> {
  await tx.update(orders).set({ needsAttention: withFlags(flags), updatedAt: sql`now()` }).where(eq(orders.id, orderId));
}

async function productSlugsOf(tx: Tx, orderId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ slug: products.slug })
    .from(orderItems)
    .innerJoin(productVariants, eq(productVariants.sku, orderItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(orderItems.orderId, orderId));
  return rows.map((row) => row.slug);
}

/** The attempt's columns that always follow the latest verified status: the gateway transaction
 * id, the method and the allowlisted snapshot. */
async function recordReport(tx: Tx, paymentId: string, report: PaymentStatusReport, status?: { status: PaymentStatus; paid?: boolean; refundedAmount?: number }) {
  await tx
    .update(payments)
    .set({
      ...(report.transactionId ? { providerRef: report.transactionId } : {}),
      ...(report.paymentType ? { paymentType: report.paymentType } : {}),
      lastStatus: report.snapshot,
      ...(status ? { status: status.status } : {}),
      ...(status?.paid ? { paidAt: sql`coalesce(${payments.paidAt}, now())` } : {}),
      ...(status?.refundedAmount !== undefined ? { refundedAmount: status.refundedAmount } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(payments.id, paymentId));
}

/** Applies one fetched status to its attempt and order. Throws on database errors (the caller
 * answers the gateway with a retryable status); never on an unexpected gateway answer, which is
 * flagged instead. */
export async function applyPaymentStatus(db: Database, report: PaymentStatusReport): Promise<ApplyResult | null> {
  const [located] = await db
    .select({ orderId: payments.orderId })
    .from(payments)
    .where(eq(payments.providerOrderId, report.providerOrderId))
    .limit(1);
  if (!located) return null;

  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, located.orderId)).for("update").limit(1);
    if (!order) throw new Error("payment attempt without its order");
    const [payment] = await tx.select().from(payments).where(eq(payments.providerOrderId, report.providerOrderId)).for("update").limit(1);
    if (!payment) throw new Error("payment attempt vanished under the order lock");
    const [latest] = await tx
      .select({ attempt: payments.attempt })
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .orderBy(desc(payments.attempt))
      .limit(1);
    const isLatestAttempt = latest?.attempt === payment.attempt;
    const result = (outcome: ApplyOutcome, productSlugs: string[] = []): ApplyResult => ({ outcome, orderNo: order.orderNo, productSlugs });

    const status = report.transactionStatus;
    if (!isKnownTransactionStatus(status)) {
      console.error("[payments] unknown transaction status; order flagged", { orderNo: order.orderNo, transactionStatus: status.slice(0, 40) });
      await recordReport(tx, payment.id, report);
      await flagOrder(tx, order.id, ["payment_anomaly"]);
      return result("unknown_status");
    }

    // Cards are never enabled (D16): a card status or a card payment type is never a payment.
    if (status === "capture" || status === "authorize" || report.paymentType === "credit_card") {
      console.error("[payments] card-only status or payment type; order flagged, never paid", { orderNo: order.orderNo, transactionStatus: status, paymentType: report.paymentType });
      await recordReport(tx, payment.id, report);
      await flagOrder(tx, order.id, ["payment_anomaly"]);
      return result("anomaly");
    }

    switch (status) {
      case "pending": {
        if (!OPEN.includes(payment.status)) {
          await recordReport(tx, payment.id, report);
          return result("unchanged");
        }
        await recordReport(tx, payment.id, report, { status: "pending" });
        return result(payment.status === "pending" ? "unchanged" : "pending");
      }

      case "deny":
      case "failure": {
        // The buyer may try another method inside the gateway page until it expires; the order waits.
        if (!OPEN.includes(payment.status)) {
          await recordReport(tx, payment.id, report);
          return result("unchanged");
        }
        await recordReport(tx, payment.id, report, { status: "failed" });
        return result(payment.status === "failed" ? "unchanged" : "failed");
      }

      case "settlement": {
        if (PAID_LIKE.includes(payment.status)) {
          await recordReport(tx, payment.id, report);
          return result("unchanged");
        }
        const amountMatches = report.grossAmount === payment.grossAmount && (report.currency === null || report.currency === "IDR");
        if (!amountMatches) {
          console.error("[payments] settled amount differs from the attempt; order flagged, never paid", {
            orderNo: order.orderNo,
            expected: payment.grossAmount,
            received: report.grossAmount,
            receivedRaw: report.snapshot.gross_amount,
            currency: report.currency,
          });
          await recordReport(tx, payment.id, report);
          await flagOrder(tx, order.id, ["amount_mismatch"]);
          return result("amount_mismatch");
        }
        if (report.fraudStatus !== null && report.fraudStatus !== "accept") {
          console.error("[payments] settlement with a fraud status other than accept; order flagged, never paid", { orderNo: order.orderNo, fraudStatus: report.fraudStatus });
          await recordReport(tx, payment.id, report);
          await flagOrder(tx, order.id, ["payment_anomaly"]);
          return result("anomaly");
        }

        await recordReport(tx, payment.id, report, { status: "paid", paid: true });

        if (ORDER_PAID_LIKE.includes(order.paymentStatus)) {
          // Another attempt of this order was paid first: this money goes back.
          console.error("[payments] second paid attempt for an already paid order; refund due", { orderNo: order.orderNo, attempt: payment.attempt });
          await flagOrder(tx, order.id, ["refund_due"]);
          return result("paid_twice");
        }
        if (order.status === "cancelled") {
          // Paid after the order was cancelled (expired, or cancelled by staff): nothing is sold,
          // the payment is recorded and refunded by hand (owner decision 2026-10-21: refund_due).
          console.error("[payments] payment for a cancelled order; refund due", { orderNo: order.orderNo });
          await tx
            .update(orders)
            .set({ paymentStatus: "paid", paidAt: sql`now()`, needsAttention: withFlags(["paid_after_cancel", "refund_due"]), updatedAt: sql`now()` })
            .where(eq(orders.id, order.id));
          return result("paid_after_cancel");
        }

        let outcome: ApplyOutcome = "paid";
        let productSlugs: string[] = [];
        if (order.status === "awaiting_payment") {
          try {
            // A savepoint (tx.transaction inside transitionOrderStatus): a refused sale rolls back
            // only the transition, never the payment record below.
            await transitionOrderStatus(order.id, "to_ship", null, tx);
            productSlugs = await productSlugsOf(tx, order.id);
          } catch (error) {
            if (!(error instanceof FieldError)) throw error;
            console.error("[payments] paid but physical stock is short; order flagged", { orderNo: order.orderNo, sku: error.field });
            outcome = "paid_stock_short";
          }
        } else {
          // Staff moved the order on before the payment was confirmed: record the payment only.
          console.warn("[payments] payment confirmed for an order already past awaiting_payment", { orderNo: order.orderNo, status: order.status });
        }
        await tx
          .update(orders)
          .set({
            paymentStatus: "paid",
            paidAt: sql`now()`,
            ...(outcome === "paid_stock_short" ? { needsAttention: withFlags(["stock_short_at_payment"]) } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(orders.id, order.id));
        return result(outcome, productSlugs);
      }

      case "expire":
      case "cancel": {
        const attemptStatus: PaymentStatus = status === "expire" ? "expired" : "cancelled";
        if (!OPEN.includes(payment.status)) {
          if (PAID_LIKE.includes(payment.status)) {
            console.error("[payments] gateway reports an already paid attempt as ended; ignored and flagged", { orderNo: order.orderNo, transactionStatus: status });
            await flagOrder(tx, order.id, ["payment_anomaly"]);
          }
          await recordReport(tx, payment.id, report);
          return result("unchanged");
        }
        await recordReport(tx, payment.id, report, { status: attemptStatus });

        // Only the latest attempt decides the order: an older attempt ending (its page was replaced
        // by a retry) never cancels an order the buyer can still pay.
        if (!isLatestAttempt || order.status !== "awaiting_payment" || order.paymentStatus !== "pending") {
          return result(status === "expire" ? "expired" : "cancelled");
        }
        await transitionOrderStatus(order.id, "cancelled", null, tx);
        await tx
          .update(orders)
          .set({
            paymentStatus: attemptStatus === "expired" ? "expired" : "cancelled",
            cancelReason: attemptStatus === "expired" ? "payment_expired" : "payment_cancelled",
            updatedAt: sql`now()`,
          })
          .where(and(eq(orders.id, order.id), eq(orders.status, "cancelled")));
        return result(status === "expire" ? "expired" : "cancelled", await productSlugsOf(tx, order.id));
      }

      case "refund":
      case "partial_refund": {
        // Monotonic: a refunded attempt never goes back to partial, and the refunded amount never
        // goes down (a late partial_refund after the full refund changes nothing).
        if (payment.status === "refunded") {
          await recordReport(tx, payment.id, report);
          return result("unchanged");
        }
        const reported = status === "refund" ? payment.grossAmount : report.refundAmount;
        if (reported === null) {
          console.error("[payments] partial refund without a usable amount; order flagged", { orderNo: order.orderNo });
          await recordReport(tx, payment.id, report);
          await flagOrder(tx, order.id, ["payment_anomaly"]);
          return result("anomaly");
        }
        const refundedAmount = Math.min(Math.max(reported, payment.refundedAmount), payment.grossAmount);
        const attemptStatus: PaymentStatus = refundedAmount === payment.grossAmount ? "refunded" : "partially_refunded";
        if (payment.status === attemptStatus && payment.refundedAmount === refundedAmount) {
          await recordReport(tx, payment.id, report);
          return result("unchanged");
        }
        const wasPaid = PAID_LIKE.includes(payment.status);
        await recordReport(tx, payment.id, report, { status: attemptStatus, paid: true, refundedAmount });

        if (!wasPaid) {
          // A refund of an attempt we never saw settle: the order was never sold, so it stays as it
          // is and staff look at it.
          console.error("[payments] refund reported for an attempt never recorded as paid; order flagged", { orderNo: order.orderNo, attempt: payment.attempt });
          await flagOrder(tx, order.id, ["payment_anomaly", "refund_received"]);
          return result("refunded");
        }
        // Another attempt still holds the order's money (a refunded duplicate payment): the order
        // stays paid, only the refund is noted.
        const [otherPaid] = await tx
          .select({ id: payments.id })
          .from(payments)
          .where(and(eq(payments.orderId, order.id), ne(payments.id, payment.id), inArray(payments.status, ["paid", "partially_refunded"])))
          .limit(1);
        if (otherPaid) {
          await flagOrder(tx, order.id, ["refund_received"]);
          return result("refunded");
        }
        // Staff decide the order status (plan §6.2).
        await tx
          .update(orders)
          .set({
            paymentStatus: attemptStatus === "refunded" ? "refunded" : "partially_refunded",
            paidAt: sql`coalesce(${orders.paidAt}, now())`,
            needsAttention: withFlags(["refund_received"]),
            updatedAt: sql`now()`,
          })
          .where(eq(orders.id, order.id));
        return result("refunded");
      }

      case "chargeback":
      case "partial_chargeback": {
        // Not expected without cards; recorded and flagged defensively (plan §6.2).
        if (payment.status === "chargeback") {
          await recordReport(tx, payment.id, report);
          return result("unchanged");
        }
        console.error("[payments] chargeback reported; order flagged", { orderNo: order.orderNo, transactionStatus: status });
        await recordReport(tx, payment.id, report, { status: "chargeback", paid: true });
        await tx
          .update(orders)
          .set({ paymentStatus: "chargeback", paidAt: sql`coalesce(${orders.paidAt}, now())`, needsAttention: withFlags(["payment_anomaly"]), updatedAt: sql`now()` })
          .where(eq(orders.id, order.id));
        return result("chargeback");
      }

      default: {
        const unhandled: never = status;
        throw new Error(`unhandled transaction status: ${String(unhandled)}`);
      }
    }
  });
}

/** The expiry sweep's last step (./sweep.ts, docs/plans/cart-checkout.md §6.3, owner decision
 * 2026-10-21): an unpaid order whose stock hold has run out and for which the gateway has no live
 * transaction (every open attempt was answered "no transaction" (404) or as ended by a status fetch
 * in the same sweep run) never gets an expiry notification, so it is expired here. Under the order
 * lock it re-checks everything: still awaiting_payment + pending, the payment window and the stock
 * hold over, no
 * attempt recorded as paid, and no open attempt the caller did not confirm (a new attempt or one the
 * gateway still reports as pending keeps the order open). Then the open attempts become `expired`
 * and the order is cancelled through transitionOrderStatus (holds released, voucher restored) with
 * `payment_status = 'expired'` and `cancel_reason = 'payment_expired'`, exactly like a gateway
 * expiry of the latest attempt. A payment that still arrives later is `paid_after_cancel`. */
export async function expireOrderWithoutLiveTransaction(db: Database, orderId: string, confirmedEndedAttempts: readonly string[]): Promise<ApplyResult | null> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, orderNo: orders.orderNo, status: orders.status, paymentStatus: orders.paymentStatus, windowOver: sql<boolean>`${orders.paymentExpiresAt} <= now()` })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update")
      .limit(1);
    if (!order) return null;
    const result = (outcome: ApplyOutcome, productSlugs: string[] = []): ApplyResult => ({ outcome, orderNo: order.orderNo, productSlugs });
    if (order.status !== "awaiting_payment" || order.paymentStatus !== "pending" || !order.windowOver) return result("unchanged");
    // The stock hold must be over too (the sweep checked it before asking the gateway; holds only
    // ever lapse or end, but nothing here relies on that).
    const [liveHold] = await tx
      .select({ id: stockReservations.id })
      .from(stockReservations)
      .where(and(eq(stockReservations.orderId, order.id), eq(stockReservations.status, "active"), sql`${stockReservations.expiresAt} > now()`))
      .limit(1);
    if (liveHold) return result("unchanged");

    const attempts = await tx
      .select({ id: payments.id, providerOrderId: payments.providerOrderId, status: payments.status })
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .orderBy(payments.attempt)
      .for("update");
    if (attempts.some((attempt) => PAID_LIKE.includes(attempt.status))) return result("unchanged");
    const open = attempts.filter((attempt) => OPEN.includes(attempt.status));
    if (open.some((attempt) => !confirmedEndedAttempts.includes(attempt.providerOrderId))) return result("unchanged");

    await cancelUnpaidCheckoutOrder(tx, order.id, {
      attempts: open.map((attempt) => ({ id: attempt.id, status: "expired" })),
      paymentStatus: "expired",
      cancelReason: "payment_expired",
      actorStaffUserId: null,
    });
    return result("expired", await productSlugsOf(tx, order.id));
  });
}

/** The last step every unpaid checkout order cancel shares (the sweep's local expiry above, and a
 * staff cancel, ./staff.ts): inside the caller's transaction, which already holds the order lock
 * and has checked that the gateway holds nothing live, the open attempts end with the given status
 * (and the gateway's own snapshot when it gave one), and the order is cancelled through
 * transitionOrderStatus (holds released, voucher restored) with its payment status and reason. */
export async function cancelUnpaidCheckoutOrder(
  tx: Tx,
  orderId: string,
  options: {
    attempts: readonly { id: string; status: "expired" | "cancelled"; snapshot?: Record<string, string | null> }[];
    paymentStatus: "expired" | "cancelled";
    cancelReason: "payment_expired" | "admin";
    actorStaffUserId: string | null;
  },
): Promise<void> {
  for (const attempt of options.attempts) {
    await tx
      .update(payments)
      .set({ status: attempt.status, ...(attempt.snapshot ? { lastStatus: attempt.snapshot } : {}), updatedAt: sql`now()` })
      .where(eq(payments.id, attempt.id));
  }
  await transitionOrderStatus(orderId, "cancelled", options.actorStaffUserId, tx, { checkoutCancelByStaff: options.actorStaffUserId !== null });
  await tx
    .update(orders)
    .set({ paymentStatus: options.paymentStatus, cancelReason: options.cancelReason, updatedAt: sql`now()` })
    .where(and(eq(orders.id, orderId), eq(orders.status, "cancelled")));
}

export { PAID_LIKE as PAID_LIKE_PAYMENT_STATUSES, OPEN as OPEN_PAYMENT_STATUSES, withFlags as withAttentionFlags, productSlugsOf };
