"use server";

import { z } from "zod";
import { changePaymentMethod, reopenPaymentPage, syncLatestPaymentStatus, type ApplyResult } from "@ammari/commerce/payments";
import { databaseErrorLogFields } from "@ammari/commerce/checkout";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { isCartEnabled } from "@/lib/cart-flag";
import { getCartClientIp } from "@/lib/cart/ip";
import { recordClaimAttemptAndCount } from "@/lib/claim/throttle";
import { defaultDb } from "@/lib/db";
import { scheduleOrderEmails } from "@/lib/emails/order-emails";
import { readOrderViewCookie } from "@/lib/orders/view-cookie";
import { getPaymentRuntime } from "@/lib/payments/runtime";
import { revalidateProductPages } from "@/lib/payments/revalidate";
import { siteOrigin } from "@/lib/site-origin";
import {
  CHECKOUT_UNAVAILABLE_MESSAGE,
  PAYMENT_CHANGE_BUSY_MESSAGE,
  PAYMENT_CHANGE_LIMIT,
  PAYMENT_CHANGE_PAID_MESSAGE,
  PAYMENT_CHANGE_WINDOW_SECONDS,
  PAYMENT_RETRY_BUSY_MESSAGE,
  PAYMENT_RETRY_CLOSED_MESSAGE,
  PAYMENT_RETRY_LIMIT,
  PAYMENT_RETRY_LIMIT_MESSAGE,
  PAYMENT_RETRY_RATE_LIMITED_MESSAGE,
  PAYMENT_RETRY_UNAVAILABLE_MESSAGE,
  PAYMENT_RETRY_WINDOW_SECONDS,
  PAYMENT_STATUS_CHECK_LIMIT,
  PAYMENT_STATUS_CHECK_WINDOW_SECONDS,
} from "./messages";
import { readOrderAccessCookie } from "./order-access-cookie";
import { findOwnedCheckoutOrderId } from "./queries";

// The payment actions of the finish page and the order page (docs/plans/cart-checkout.md §4.4,
// §9.1):
// - checkPaymentStatusAction: the one server-side status check of a pending order. The gateway's
//   status (fetched server to server, never the redirect's query string) goes through the same
//   state machine as a notification; the page re-renders from our database when it changed.
// - reopenPaymentPageAction: "Buka halaman pembayaran" when the payment page could not be created
//   (a new attempt for the rest of the order's window).
// - changePaymentMethodAction: "Ganti metode pembayaran": ends the earlier attempts at the gateway,
//   then a new attempt (a fresh payment page with every method) for the rest of the window.
// Server actions (Next's Origin check is the CSRF guard), behind the cart flag, for the buyer who
// may see the order only (lib/orders/access.ts: the session, the checkout's cookie on the finish
// page, or the "Lihat pesanan" cookie on the order page), each with a per-IP limit.

const orderNoSchema = z.string().regex(/^ORD-[0-9]{6}-[0-9]{4,}$/);

/** `viewLink`: also accept the "Lihat pesanan" cookie. Plan §9.2 lets that emailed, 120-day link
 * only view the order and re-open the stored payment page, so it may run the status check (which
 * only applies the gateway's own answer) but never open a new payment attempt (security review,
 * session 15). */
async function ownedOrderId(orderNo: unknown, options: { viewLink: boolean }): Promise<string | null> {
  const parsed = orderNoSchema.safeParse(orderNo);
  if (!parsed.success) return null;
  const [session, checkoutToken, viewToken] = await Promise.all([getCustomerSession(), readOrderAccessCookie(), readOrderViewCookie(parsed.data)]);
  const accessTokens = options.viewLink ? [checkoutToken, viewToken] : [checkoutToken];
  return findOwnedCheckoutOrderId({ orderNo: parsed.data, sessionCustomerId: session?.id ?? null, accessTokens });
}

/** `changed`: the order's payment state moved, so the page should re-read it. */
export async function checkPaymentStatusAction(orderNo: string): Promise<{ changed: boolean }> {
  if (!isCartEnabled()) return { changed: false };
  try {
    const ip = await getCartClientIp("payment status check");
    if (!ip) return { changed: false };
    const orderId = await ownedOrderId(orderNo, { viewLink: true });
    if (!orderId) return { changed: false };
    const runtime = getPaymentRuntime();
    if (!runtime) {
      console.warn("[checkout] finish page status check skipped: payment provider not configured");
      return { changed: false };
    }
    const result = await syncLatestPaymentStatus(defaultDb, runtime.provider, orderId, {
      // Counted only when the gateway is really asked (shared mobile IPs are common).
      admit: async () => {
        const admitted = (await recordClaimAttemptAndCount(defaultDb, ip, "payment_status_check", PAYMENT_STATUS_CHECK_WINDOW_SECONDS)) <= PAYMENT_STATUS_CHECK_LIMIT;
        if (!admitted) console.warn("[checkout] finish page status check over the per-IP limit; page keeps its own state");
        return admitted;
      },
    });
    if (!result.checked) return { changed: false };
    revalidateProductPages(result.applied.productSlugs, { orderNo: result.applied.orderNo });
    const changed = result.applied.outcome !== "unchanged";
    if (changed) scheduleOrderEmails([{ orderNo: result.applied.orderNo }], "finish page status check");
    return { changed };
  } catch (error) {
    // The page keeps showing our own state; the notification or the sweep finalizes it.
    console.error("[checkout] finish page status check failed", databaseErrorLogFields(error));
    return { changed: false };
  }
}

export type ReopenPaymentPageActionResult = { ok: true; redirectUrl: string } | { ok: false; message: string };

const RETRY_REFUSALS = {
  closed: PAYMENT_RETRY_CLOSED_MESSAGE,
  limit: PAYMENT_RETRY_LIMIT_MESSAGE,
  busy: PAYMENT_RETRY_BUSY_MESSAGE,
  unavailable: PAYMENT_RETRY_UNAVAILABLE_MESSAGE,
} as const;

export async function reopenPaymentPageAction(orderNo: string): Promise<ReopenPaymentPageActionResult> {
  if (!isCartEnabled()) return { ok: false, message: CHECKOUT_UNAVAILABLE_MESSAGE };
  try {
    const ip = await getCartClientIp("payment retry");
    if (!ip) return { ok: false, message: PAYMENT_RETRY_UNAVAILABLE_MESSAGE };
    // Counted before the ownership lookup, so guessing numbers or tokens is throttled too.
    if ((await recordClaimAttemptAndCount(defaultDb, ip, "payment_retry", PAYMENT_RETRY_WINDOW_SECONDS)) > PAYMENT_RETRY_LIMIT) {
      return { ok: false, message: PAYMENT_RETRY_RATE_LIMITED_MESSAGE };
    }
    const orderId = await ownedOrderId(orderNo, { viewLink: false });
    if (!orderId) return { ok: false, message: PAYMENT_RETRY_CLOSED_MESSAGE };
    const runtime = getPaymentRuntime();
    if (!runtime) {
      console.warn("[checkout] payment page retry refused: payment provider not configured");
      return { ok: false, message: PAYMENT_RETRY_UNAVAILABLE_MESSAGE };
    }
    const origin = siteOrigin();
    const result = await reopenPaymentPage(defaultDb, runtime, {
      orderId,
      finishUrl: (number) => `${origin}/checkout/finish?order=${encodeURIComponent(number)}`,
    });
    if (result.ok) return { ok: true, redirectUrl: result.redirectUrl };
    return { ok: false, message: RETRY_REFUSALS[result.reason] };
  } catch (error) {
    console.error("[checkout] reopening the payment page failed", databaseErrorLogFields(error));
    return { ok: false, message: PAYMENT_RETRY_UNAVAILABLE_MESSAGE };
  }
}

export type ChangePaymentMethodActionResult =
  | { ok: true; redirectUrl: string }
  /** `refresh`: the order's payment state moved (an earlier attempt turned out paid, or the order
   * closed), so the page should re-read it. */
  | { ok: false; message: string; refresh: boolean };

const CHANGE_REFUSALS = {
  closed: PAYMENT_RETRY_CLOSED_MESSAGE,
  paid: PAYMENT_CHANGE_PAID_MESSAGE,
  limit: PAYMENT_RETRY_LIMIT_MESSAGE,
  busy: PAYMENT_CHANGE_BUSY_MESSAGE,
  unavailable: PAYMENT_RETRY_UNAVAILABLE_MESSAGE,
} as const;

/** Product pages and emails for what the gateway reported about the earlier attempts. Isolated: a
 * failure here never changes the answer the buyer gets (the database already moved). */
function followUpApplied(applied: readonly ApplyResult[]): void {
  for (const result of applied) {
    try {
      revalidateProductPages(result.productSlugs, { orderNo: result.orderNo });
      if (result.outcome !== "unchanged") scheduleOrderEmails([{ orderNo: result.orderNo }], "payment method change");
    } catch (error) {
      console.error("[checkout] payment method change: follow-up after a gateway report failed", { orderNo: result.orderNo, outcome: result.outcome, ...databaseErrorLogFields(error) });
    }
  }
}

export async function changePaymentMethodAction(orderNo: string): Promise<ChangePaymentMethodActionResult> {
  if (!isCartEnabled()) return { ok: false, message: CHECKOUT_UNAVAILABLE_MESSAGE, refresh: false };
  let phase = "rate_limit";
  try {
    const ip = await getCartClientIp("payment method change");
    if (!ip) return { ok: false, message: PAYMENT_RETRY_UNAVAILABLE_MESSAGE, refresh: false };
    // Counted before the ownership lookup, so guessing numbers or tokens is throttled too. The
    // count is of the earlier attempts: at most PAYMENT_CHANGE_LIMIT per window get through.
    if ((await recordClaimAttemptAndCount(defaultDb, ip, "payment_method_change", PAYMENT_CHANGE_WINDOW_SECONDS)) >= PAYMENT_CHANGE_LIMIT) {
      return { ok: false, message: PAYMENT_RETRY_RATE_LIMITED_MESSAGE, refresh: false };
    }
    // Like a new attempt from "Buka halaman pembayaran": the session or the checkout's cookie,
    // never the emailed view-only link (plan §9.2).
    phase = "ownership";
    const orderId = await ownedOrderId(orderNo, { viewLink: false });
    if (!orderId) return { ok: false, message: PAYMENT_RETRY_CLOSED_MESSAGE, refresh: false };
    phase = "change";
    const runtime = getPaymentRuntime();
    if (!runtime) {
      console.warn("[checkout] payment method change refused: payment provider not configured");
      return { ok: false, message: PAYMENT_RETRY_UNAVAILABLE_MESSAGE, refresh: false };
    }
    const origin = siteOrigin();
    const result = await changePaymentMethod(defaultDb, runtime, {
      orderId,
      finishUrl: (number) => `${origin}/checkout/finish?order=${encodeURIComponent(number)}`,
    });
    // What the gateway reported about the earlier attempts (paid, ended) went through the state
    // machine: its product pages and emails follow as after any status check.
    followUpApplied(result.applied ?? []);
    if (result.ok) return { ok: true, redirectUrl: result.redirectUrl };
    return { ok: false, message: CHANGE_REFUSALS[result.reason], refresh: result.reason === "paid" || result.reason === "closed" };
  } catch (error) {
    // `refresh`: the order may have moved before the failure; the page re-reads our own state.
    console.error("[checkout] payment method change failed", { orderNo: String(orderNo).slice(0, 40), phase, ...databaseErrorLogFields(error) });
    return { ok: false, message: PAYMENT_RETRY_UNAVAILABLE_MESSAGE, refresh: phase === "change" };
  }
}
