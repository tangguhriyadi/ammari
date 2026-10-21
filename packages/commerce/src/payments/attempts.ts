import "server-only";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { fabricColors, orderItems, orders, payments, products, productVariants } from "@ammari/db/schema";
import type { Database } from "../db";
import type { PaymentRuntime } from "./config";
import { buildPaymentLines, providerOrderId, type PaymentProductLine } from "./lines";
import { errorLogFields } from "../errors";
import { OPEN_PAYMENT_STATUSES, applyPaymentStatus, type ApplyResult } from "./apply-status";
import { PAYMENT_STATUS_TIMEOUT_MS, PaymentProviderError, type PaymentLine, type PaymentStatusReport } from "./provider";

// Payment pages for an attempt (docs/plans/cart-checkout.md §4.4, §5 step 11, D7). placeOrder asks
// for attempt 1's page after its order commits; when that failed (gateway down, timeout), the
// finish page's "Buka halaman pembayaran" opens a NEW attempt (`<prefix><order_no>-<n>`; Midtrans
// refuses a used order id with 406) whose window ends when the order's does. "Ganti metode
// pembayaran" (changePaymentMethod, below) also opens a new attempt, after ending the earlier ones at
// the gateway. Every attempt's notification goes through the same state machine; only the latest
// attempt's expiry cancels the order (./apply-status.ts).

/** The gateway page request runs in the buyer's request: past this it counts as unavailable. */
export const PAYMENT_PAGE_TIMEOUT_MS = 15_000;
/** At most this many attempts per order (a retry loop never makes dozens of gateway orders). */
export const MAX_PAYMENT_ATTEMPTS = 5;
/** An attempt without a page touched less than this long ago may still get one
 * (PAYMENT_PAGE_TIMEOUT_MS plus a margin). Measured from `updated_at`: a new attempt is created with
 * it, and "Ganti metode pembayaran" touches it again right before it asks for the page. */
const IN_FLIGHT_SECONDS = 20;

/** A page request for this attempt may still be answered (another tap or tab, up to the 15 s cap). */
const pageRequestInFlight = () => sql<boolean>`${payments.snapToken} is null and ${payments.updatedAt} > now() - make_interval(secs => ${IN_FLIGHT_SECONDS}::int)`;
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
        inFlight: pageRequestInFlight(),
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

// ---------- "Ganti metode pembayaran" ----------

export type ChangePaymentMethodResult =
  /** `applied`: what the gateway reported for the earlier attempts, already applied through the
   * state machine (the caller revalidates pages and sends emails for them). */
  | { ok: true; redirectUrl: string; applied: ApplyResult[] }
  /** `paid`: an earlier attempt turned out to be paid (the order is paid now; the page should
   * re-read it); `busy`: an earlier attempt is still payable at the gateway, or a page request is in
   * flight; the others as for reopenPaymentPage. */
  | { ok: false; reason: "closed" | "paid" | "limit" | "busy" | "unavailable"; applied?: ApplyResult[] };

/** All gateway calls on the earlier attempts of one change together (the buyer is waiting). Below
 * IN_FLIGHT_SECONDS, so the reserved attempt still counts as in flight until it is touched again
 * right before its page request. */
export const CHANGE_PAYMENT_GATEWAY_BUDGET_MS = 12_000;

/** Gateway statuses after which the buyer can no longer pay that attempt (same set as the sweep and
 * the staff cancel). */
const ENDED_AT_GATEWAY = new Set(["expire", "cancel", "deny", "failure"]);

/** "Ganti metode pembayaran" on the finish page and /orders/<no> (owner request after the
 * 2026-10-21 sandbox run: a buyer who picked GoPay QR in the payment page and closed it could only
 * reopen that same page, locked to GoPay QR). Opens a NEW attempt (`<prefix><order_no>-<n>`, a new
 * payment page where every method can be chosen again) for the same order and the rest of its
 * payment window, after making sure no earlier attempt can still be paid:
 *
 * 1. Under the order lock the next attempt is reserved (inserted without a page). From then on it is
 *    the latest attempt, so an earlier attempt's expiry (ours below, or the gateway's own) can never
 *    cancel the order (./apply-status.ts: only the latest attempt's end does), and a second tap or
 *    "Buka halaman pembayaran" in another tab is told the page is being prepared.
 * 2. Outside any transaction, every earlier open attempt is asked at the gateway: a pending one is
 *    expired (Midtrans Expire), and its answer goes through the state machine. A settlement there
 *    pays the order (and ends this change as `paid`); an attempt the gateway cannot confirm as ended
 *    or absent ends the change as `busy` or `unavailable`. In both cases the reserved attempt is
 *    removed again (it never reached the gateway), so the order is exactly as before.
 * 3. Under the order lock again: still payable, the reservation still the latest attempt without a
 *    page, and no open attempt the gateway was not asked about. Only then is the new page requested.
 *
 * Never two live payable attempts from this path: the earlier attempts are ended (or confirmed to
 * have no transaction) before the new page exists. An attempt with no transaction yet has nothing to
 * expire at the gateway; a payment the buyer still starts on its old page later is a second payment
 * the state machine flags `refund_due` (never silent). The caller has already checked that the
 * visitor may change the order's payment and applied the rate limit. */
export async function changePaymentMethod(
  db: Database,
  runtime: PaymentRuntime,
  params: { orderId: string; finishUrl: (orderNo: string) => string; gatewayBudgetMs?: number },
): Promise<ChangePaymentMethodResult> {
  // 1. Reserve the next attempt.
  type Reserved = { kind: "reserved"; paymentId: string; providerOrderId: string; earlier: string[] } | { kind: "refused"; reason: "closed" | "limit" | "busy" };
  const reserved: Reserved = await db.transaction(async (tx) => {
    const [order] = await tx
      .select({
        id: orders.id,
        orderNo: orders.orderNo,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        totalAmount: orders.totalAmount,
        minutesLeft: sql<number>`floor(extract(epoch from (${orders.paymentExpiresAt} - now())) / 60)::int`,
      })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .for("update")
      .limit(1);
    if (!order || order.status !== "awaiting_payment" || order.paymentStatus !== "pending") return { kind: "refused", reason: "closed" };
    if ((order.minutesLeft ?? 0) < MIN_RETRY_MINUTES) return { kind: "refused", reason: "closed" };
    const attempts = await tx
      .select({ attempt: payments.attempt, providerOrderId: payments.providerOrderId, status: payments.status, inFlight: pageRequestInFlight() })
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .orderBy(desc(payments.attempt))
      .for("update");
    const latest = attempts[0];
    if (latest?.status === "created" && latest.inFlight) return { kind: "refused", reason: "busy" };
    const attempt = (latest?.attempt ?? 0) + 1;
    if (attempt > MAX_PAYMENT_ATTEMPTS) return { kind: "refused", reason: "limit" };
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
    // Newest first (the query's order): if the change stops half way, the attempt left as the
    // latest one is the one still open, never one just ended here.
    const earlier = attempts.filter((row) => OPEN_PAYMENT_STATUSES.includes(row.status)).map((row) => row.providerOrderId);
    return { kind: "reserved", paymentId: payment.id, providerOrderId: paymentOrderId, earlier };
  });
  if (reserved.kind === "refused") return { ok: false, reason: reserved.reason };

  const where = { orderId: params.orderId, providerOrderId: reserved.providerOrderId };
  /** Set while an expire was sent for an earlier attempt whose answer is not yet recorded: the
   * gateway may have ended it without us knowing. */
  let unrecordedExpire: string | null = null;
  const release = async (reason: "closed" | "paid" | "busy" | "unavailable", applied: ApplyResult[], log: Record<string, unknown>): Promise<ChangePaymentMethodResult> => {
    if (unrecordedExpire) {
      // Keep the reservation as the latest attempt: had it gone, that earlier attempt (maybe ended
      // at the gateway) would be the latest again and its expiry notification would cancel an order
      // the buyer still wants to pay. The pageless reservation stops counting as in flight after
      // IN_FLIGHT_SECONDS; the sweep and staff cancel treat it as an attempt without a transaction.
      console.warn("[checkout] payment method change refused; reservation kept after an unconfirmed expiry", { ...where, reason, earlier: unrecordedExpire, ...log });
      return { ok: false, reason, applied };
    }
    // Never sent to the gateway, so removing it leaves the order exactly as before this change
    // (its attempt number and provider order id are free again for that reason only). A failure
    // here leaves a pageless attempt that stops counting as in flight after a few seconds.
    try {
      await db.transaction(async (tx) => {
        await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, params.orderId)).for("update");
        await tx.delete(payments).where(and(eq(payments.id, reserved.paymentId), eq(payments.status, "created"), isNull(payments.snapToken)));
      });
    } catch (error) {
      console.error("[checkout] payment method change: reserved attempt not released", { ...where, ...errorLogFields(error) });
    }
    console.warn("[checkout] payment method change refused", { ...where, reason, ...log });
    return { ok: false, reason, applied };
  };

  // 2. End every earlier open attempt at the gateway. No gateway call inside a transaction.
  const deadline = Date.now() + (params.gatewayBudgetMs ?? CHANGE_PAYMENT_GATEWAY_BUDGET_MS);
  const signal = () => AbortSignal.timeout(Math.max(1, Math.min(PAYMENT_STATUS_TIMEOUT_MS, deadline - Date.now())));
  const confirmed = new Set<string>();
  const applied: ApplyResult[] = [];
  for (const earlier of reserved.earlier) {
    let report: PaymentStatusReport | null;
    let step: "status" | "expire" = "status";
    try {
      if (Date.now() >= deadline) return await release("unavailable", applied, { earlier, cause: "time_budget" });
      report = await runtime.provider.getPaymentStatus(earlier, { signal: signal() });
      if (report?.transactionStatus === "pending") {
        step = "expire";
        unrecordedExpire = earlier;
        const expired = await runtime.provider.expirePayment(earlier, { signal: signal() });
        step = "status";
        // 404/412: nothing to expire (any more); the status says what happened instead.
        report = expired ?? (await runtime.provider.getPaymentStatus(earlier, { signal: signal() }));
      }
    } catch (error) {
      return await release("unavailable", applied, { earlier, step, ...(error instanceof PaymentProviderError ? error.logFields() : errorLogFields(error)) });
    }
    if (!report) {
      // No transaction at the gateway: the buyer never picked a method on that page.
      unrecordedExpire = null;
      confirmed.add(earlier);
      continue;
    }
    // Recorded through the state machine either way; the reserved attempt is the latest one, so an
    // ended earlier attempt never cancels the order.
    let result: ApplyResult | null;
    try {
      result = await applyPaymentStatus(db, report);
    } catch (error) {
      return await release("unavailable", applied, { earlier, step: "apply", transactionStatus: report.transactionStatus, ...errorLogFields(error) });
    }
    unrecordedExpire = null;
    if (result) applied.push(result);
    if (ENDED_AT_GATEWAY.has(report.transactionStatus)) {
      confirmed.add(earlier);
      continue;
    }
    const log = { earlier, transactionStatus: report.transactionStatus, outcome: result?.outcome ?? null };
    if (report.transactionStatus === "settlement") return await release("paid", applied, log);
    // Still pending after the expire (the gateway refused it), or a status the state machine
    // flagged for staff: never a second payable page next to it.
    return await release("busy", applied, log);
  }

  // 3. Re-check under the order lock, then ask for the new page.
  type Prepared = { kind: "request"; request: PaymentPageRequest } | { kind: "refused"; reason: "closed" | "paid" | "busy" };
  let prepared: Prepared;
  try {
    prepared = await db.transaction(async (tx) => {
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
      if (!order) return { kind: "refused", reason: "closed" };
      if (order.paymentStatus !== null && order.paymentStatus !== "pending") return { kind: "refused", reason: order.paymentStatus === "paid" ? "paid" : "closed" };
      if (order.status !== "awaiting_payment" || (order.minutesLeft ?? 0) < MIN_RETRY_MINUTES) return { kind: "refused", reason: "closed" };
      const attempts = await tx
        .select({ id: payments.id, attempt: payments.attempt, providerOrderId: payments.providerOrderId, status: payments.status, snapToken: payments.snapToken })
        .from(payments)
        .where(eq(payments.orderId, order.id))
        .orderBy(desc(payments.attempt))
        .for("update");
      const latest = attempts[0];
      if (!latest || latest.id !== reserved.paymentId || latest.status !== "created" || latest.snapToken !== null) return { kind: "refused", reason: "busy" };
      const unasked = attempts.filter((row) => row.id !== reserved.paymentId && OPEN_PAYMENT_STATUSES.includes(row.status) && !confirmed.has(row.providerOrderId));
      if (unasked.length > 0) return { kind: "refused", reason: "busy" };
      if (!order.contactEmail || !order.contactPhone || !order.recipientName) throw new Error("checkout order without its contact snapshot");
      // Counts as in flight again from now, for the page request below.
      await tx.update(payments).set({ updatedAt: sql`now()` }).where(eq(payments.id, reserved.paymentId));
      const lines = buildPaymentLines({
        products: await orderPaymentProductLines(tx, order.id),
        shippingAmount: order.shippingAmount,
        discountAmount: order.discountAmount,
        grossAmount: order.totalAmount,
      });
      return {
        kind: "request",
        request: {
          paymentId: reserved.paymentId,
          orderNo: order.orderNo,
          providerOrderId: reserved.providerOrderId,
          grossAmount: order.totalAmount,
          lines,
          customer: { name: order.recipientName, email: order.contactEmail, phone: order.contactPhone },
          // The same order and the rest of its window, never past its own deadline.
          expiryMinutes: Math.min(order.minutesLeft, runtime.paymentExpiryMinutes),
          finishUrl: params.finishUrl(order.orderNo),
        },
      };
    });
  } catch (error) {
    return release("unavailable", applied, { step: "recheck", ...errorLogFields(error) });
  }
  if (prepared.kind === "refused") return release(prepared.reason, applied, { step: "recheck" });

  const redirectUrl = await requestPaymentPage(db, runtime, prepared.request);
  if (!redirectUrl) {
    // The earlier pages are already closed; "Buka halaman pembayaran" opens a new one.
    console.warn("[checkout] payment method change: earlier attempts ended but the new page was not created", { ...where, endedEarlier: [...confirmed] });
    return { ok: false, reason: "unavailable", applied };
  }
  // The earlier pages are closed; whatever the buyer picks happens on this one.
  console.info("[checkout] payment method change: new attempt opened", { ...where, endedEarlier: [...confirmed] });
  return { ok: true, redirectUrl, applied };
}
