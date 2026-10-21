"use server";

import { z } from "zod";
import { reopenPaymentPage, syncLatestPaymentStatus } from "@ammari/commerce/payments";
import { databaseErrorLogFields } from "@ammari/commerce/checkout";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { isCartEnabled } from "@/lib/cart-flag";
import { getCartClientIp } from "@/lib/cart/ip";
import { recordClaimAttemptAndCount } from "@/lib/claim/throttle";
import { defaultDb } from "@/lib/db";
import { getPaymentRuntime } from "@/lib/payments/runtime";
import { revalidateProductPages } from "@/lib/payments/revalidate";
import { siteOrigin } from "@/lib/site-origin";
import {
  CHECKOUT_UNAVAILABLE_MESSAGE,
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

// The finish page's two payment actions (docs/plans/cart-checkout.md §4.4, session 10 note):
// - checkPaymentStatusAction: the one server-side status check of a pending order. The gateway's
//   status (fetched server to server, never the redirect's query string) goes through the same
//   state machine as a notification; the page re-renders from our database when it changed.
// - reopenPaymentPageAction: "Buka halaman pembayaran" when the payment page could not be created
//   (a new attempt for the rest of the order's window).
// Server actions (Next's Origin check is the CSRF guard), behind the cart flag, for the buyer who
// may see the finish page only (session or the checkout cookie), each with a per-IP limit.

const orderNoSchema = z.string().regex(/^ORD-[0-9]{6}-[0-9]{4,}$/);

async function ownedOrderId(orderNo: unknown): Promise<string | null> {
  const parsed = orderNoSchema.safeParse(orderNo);
  if (!parsed.success) return null;
  const [session, accessToken] = await Promise.all([getCustomerSession(), readOrderAccessCookie()]);
  return findOwnedCheckoutOrderId({ orderNo: parsed.data, sessionCustomerId: session?.id ?? null, accessToken });
}

/** `changed`: the order's payment state moved, so the page should re-read it. */
export async function checkPaymentStatusAction(orderNo: string): Promise<{ changed: boolean }> {
  if (!isCartEnabled()) return { changed: false };
  try {
    const ip = await getCartClientIp("payment status check");
    if (!ip) return { changed: false };
    const orderId = await ownedOrderId(orderNo);
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
    return { changed: result.applied.outcome !== "unchanged" };
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
    const orderId = await ownedOrderId(orderNo);
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
