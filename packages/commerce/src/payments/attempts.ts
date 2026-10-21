import "server-only";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { fabricColors, orderItems, orders, payments, products, productVariants } from "@ammari/db/schema";
import type { Database } from "../db";
import type { PaymentRuntime } from "./config";
import { buildPaymentLines, providerOrderId, type PaymentProductLine } from "./lines";
import { PaymentProviderError, type PaymentLine } from "./provider";

// Payment pages for an attempt (docs/plans/cart-checkout.md §4.4, §5 step 11, D7). placeOrder asks
// for attempt 1's page after its order commits; when that failed (gateway down, timeout), the
// finish page's "Buka halaman pembayaran" opens a NEW attempt (`<prefix><order_no>-<n>`; Midtrans
// refuses a used order id with 406) whose window ends when the order's does. Every attempt's
// notification goes through the same state machine; only the latest attempt's expiry cancels the
// order (./apply-status.ts).

/** The gateway page request runs in the buyer's request: past this it counts as unavailable. */
export const PAYMENT_PAGE_TIMEOUT_MS = 15_000;
/** At most this many attempts per order (a retry loop never makes dozens of gateway orders). */
export const MAX_PAYMENT_ATTEMPTS = 5;
/** An attempt without a page younger than this may still get one (PAYMENT_PAGE_TIMEOUT_MS plus a
 * margin). */
const IN_FLIGHT_SECONDS = 20;
/** A retry needs at least this much of the order's window left to be worth a new page. */
const MIN_RETRY_MINUTES = 2;

export interface PaymentPageRequest {
  paymentId: string;
  orderNo: string;
  providerOrderId: string;
  grossAmount: number;
  lines: readonly PaymentLine[];
  customer: { name: string; email: string; phone: string };
  expiryMinutes: number;
  finishUrl: string;
}

/** Asks the provider for the attempt's payment page and stores it. Never throws: the order is
 * already committed, so a failure only leaves the attempt without a page (logged with the typed
 * reason, never a key or the buyer's data). */
export async function requestPaymentPage(db: Database, runtime: PaymentRuntime, request: PaymentPageRequest): Promise<string | null> {
  let created: { token: string; redirectUrl: string };
  const signal = AbortSignal.timeout(PAYMENT_PAGE_TIMEOUT_MS);
  // The race below caps an adapter that ignores `signal`; its listener is removed either way.
  let onAbort: (() => void) | null = null;
  let pending: Promise<{ token: string; redirectUrl: string }>;
  try {
    pending = runtime.provider.createPayment({
      providerOrderId: request.providerOrderId,
      grossAmount: request.grossAmount,
      lines: request.lines,
      customer: request.customer,
      expiryMinutes: request.expiryMinutes,
      finishUrl: request.finishUrl,
      signal,
    });
    created = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new PaymentProviderError("unavailable", "payment provider timed out"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    // A late rejection of the losing request is already handled by the race; keep it quiet.
    pending.catch(() => undefined);
  } catch (error) {
    const where = { orderNo: request.orderNo, providerOrderId: request.providerOrderId, provider: runtime.provider.name };
    if (error instanceof PaymentProviderError) {
      console.error("[checkout] payment page not created; order stays pending", { ...where, ...error.logFields() });
    } else {
      // A bug in the adapter: its name only (a message could echo the request, i.e. buyer data).
      console.error("[checkout] payment page not created (unexpected error); order stays pending", { ...where, error: error instanceof Error ? error.name : typeof error });
    }
    return null;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }

  const where = { orderNo: request.orderNo, paymentId: request.paymentId, providerOrderId: request.providerOrderId };
  try {
    const stored = await db
      .update(payments)
      .set({ snapToken: created.token, redirectUrl: created.redirectUrl, updatedAt: sql`now()` })
      .where(and(eq(payments.id, request.paymentId), isNull(payments.snapToken)))
      .returning({ id: payments.id });
    if (stored.length === 0) console.error("[checkout] payment page created but the attempt already had one; not stored", where);
  } catch (error) {
    // The buyer can still pay through the page they are sent to; the notification matches the
    // attempt by provider_order_id. Only a later "Lanjutkan pembayaran" lacks the stored URL.
    // Never the driver's message: a failed query's text carries its parameters.
    const cause = (error instanceof Error ? (error.cause ?? error) : {}) as { code?: unknown };
    console.error("[checkout] payment page created but not stored", { ...where, error: error instanceof Error ? error.name : typeof error, code: cause.code });
  }
  return created.redirectUrl;
}

function sizeLabel(size: string): string {
  return size === "ALLSIZE" ? "All Size" : size;
}

/** The product lines of an order as the gateway shows them (same names as placeOrder). */
export async function orderPaymentProductLines(db: Database, orderId: string): Promise<PaymentProductLine[]> {
  const rows = await db
    .select({ sku: orderItems.sku, productName: products.name, colorName: fabricColors.name, size: productVariants.size, qty: orderItems.qty, unitPrice: orderItems.unitPrice })
    .from(orderItems)
    .innerJoin(productVariants, eq(productVariants.sku, orderItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.sku));
  return rows.map((row) => ({ sku: row.sku, name: `${row.productName} ${row.colorName} ${sizeLabel(row.size)}`, unitPrice: row.unitPrice, qty: row.qty }));
}

export type ReopenPaymentPageResult =
  | { ok: true; redirectUrl: string }
  /** `closed`: no longer payable (paid, cancelled, or the window is over); `limit`: too many
   * attempts; `busy`: the previous request for a page may still be answered; `unavailable`: the
   * gateway did not give a page this time. */
  | { ok: false; reason: "closed" | "limit" | "busy" | "unavailable" };

/** "Buka halaman pembayaran" on the finish page: the latest attempt's page when it has one,
 * otherwise a new attempt for the rest of the order's window. The caller has already checked that
 * the visitor may see the order. */
export async function reopenPaymentPage(
  db: Database,
  runtime: PaymentRuntime,
  params: { orderId: string; finishUrl: (orderNo: string) => string },
): Promise<ReopenPaymentPageResult> {
  type Prepared = { kind: "existing"; redirectUrl: string } | { kind: "new"; request: PaymentPageRequest } | { kind: "refused"; reason: "closed" | "limit" | "busy" };

  const prepared: Prepared = await db.transaction(async (tx) => {
    // The order lock serializes two retries (two taps, two tabs) and the notification handler.
    const [order] = await tx
      .select({
        id: orders.id,
        orderNo: orders.orderNo,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        totalAmount: orders.totalAmount,
        shippingAmount: orders.shippingAmount,
        discountAmount: orders.discountAmount,
        recipientName: orders.recipientName,
        contactEmail: orders.contactEmail,
        contactPhone: orders.contactPhone,
        minutesLeft: sql<number>`floor(extract(epoch from (${orders.paymentExpiresAt} - now())) / 60)::int`,
      })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .for("update")
      .limit(1);
    if (!order || order.status !== "awaiting_payment" || order.paymentStatus !== "pending") return { kind: "refused", reason: "closed" };
    if ((order.minutesLeft ?? 0) < MIN_RETRY_MINUTES) return { kind: "refused", reason: "closed" };

    const [latest] = await tx
      .select({
        attempt: payments.attempt,
        redirectUrl: payments.redirectUrl,
        status: payments.status,
        // A page request for it may still be on its way (another tap or tab, up to the 15 s cap).
        inFlight: sql<boolean>`${payments.snapToken} is null and ${payments.createdAt} > now() - make_interval(secs => ${IN_FLIGHT_SECONDS}::int)`,
      })
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .orderBy(desc(payments.attempt))
      .limit(1);
    if (latest?.redirectUrl && (latest.status === "created" || latest.status === "pending" || latest.status === "failed")) {
      return { kind: "existing", redirectUrl: latest.redirectUrl };
    }
    // Never a second gateway order while the first one's page may still arrive: the buyer could
    // end up with two payable pages (and pay twice).
    if (latest?.status === "created" && latest.inFlight) return { kind: "refused", reason: "busy" };
    const attempt = (latest?.attempt ?? 0) + 1;
    if (attempt > MAX_PAYMENT_ATTEMPTS) return { kind: "refused", reason: "limit" };
    if (!order.contactEmail || !order.contactPhone || !order.recipientName) throw new Error("checkout order without its contact snapshot");

    const lines = buildPaymentLines({
      products: await orderPaymentProductLines(tx, order.id),
      shippingAmount: order.shippingAmount,
      discountAmount: order.discountAmount,
      grossAmount: order.totalAmount,
    });
    const paymentOrderId = providerOrderId(runtime.orderIdPrefix, order.orderNo, attempt);
    const [payment] = await tx
      .insert(payments)
      .values({
        orderId: order.id,
        provider: "midtrans",
        providerOrderId: paymentOrderId,
        attempt,
        grossAmount: order.totalAmount,
        status: "created",
        expiresAt: sql`(select ${orders.paymentExpiresAt} from ${orders} where ${eq(orders.id, order.id)})`,
      })
      .returning({ id: payments.id });
    if (!payment) throw new Error("failed to insert payment attempt");
    return {
      kind: "new",
      request: {
        paymentId: payment.id,
        orderNo: order.orderNo,
        providerOrderId: paymentOrderId,
        grossAmount: order.totalAmount,
        lines,
        customer: { name: order.recipientName, email: order.contactEmail, phone: order.contactPhone },
        // Never past the order's own deadline.
        expiryMinutes: Math.min(order.minutesLeft, runtime.paymentExpiryMinutes),
        finishUrl: params.finishUrl(order.orderNo),
      },
    };
  });

  if (prepared.kind === "refused") return { ok: false, reason: prepared.reason };
  if (prepared.kind === "existing") return { ok: true, redirectUrl: prepared.redirectUrl };
  const redirectUrl = await requestPaymentPage(db, runtime, prepared.request);
  return redirectUrl ? { ok: true, redirectUrl } : { ok: false, reason: "unavailable" };
}
