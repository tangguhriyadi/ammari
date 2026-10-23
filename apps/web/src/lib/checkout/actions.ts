"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { databaseErrorLogFields, placeOrder, type PlaceOrderFieldError } from "@ammari/commerce/checkout";
import { PLACE_ORDER_MESSAGES } from "@ammari/commerce/checkout-messages";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { isCartEnabled } from "@/lib/cart-flag";
import { getCartClientIp } from "@/lib/cart/ip";
import { clearGuestCartCookie, readCartIdentity } from "@/lib/cart/identity";
import { recordClaimAttemptAndCount } from "@/lib/claim/throttle";
import { HOMEPAGE_CACHE_TAG } from "@/lib/content/homepage-data";
import { PRODUCTS_CACHE_TAG, productCacheTag } from "@/lib/content/product-data";
import { defaultDb } from "@/lib/db";
import { scheduleOrderEmails } from "@/lib/emails/order-emails";
import { getPaymentRuntime } from "@/lib/payments/runtime";
import { getShippingRuntime } from "@/lib/shipping/runtime";
import { siteOrigin } from "@/lib/site-origin";
import {
  CHECKOUT_GENERIC_ERROR_MESSAGE,
  CHECKOUT_INVALID_INPUT_MESSAGE,
  CHECKOUT_PAYMENT_UNAVAILABLE_MESSAGE,
  CHECKOUT_SUBMIT_LIMIT,
  CHECKOUT_SUBMIT_WINDOW_SECONDS,
  CHECKOUT_UNAVAILABLE_MESSAGE,
} from "./messages";
import { readOrderAccessCookie, writeOrderAccessCookie } from "./order-access-cookie";

// "Bayar sekarang" (docs/plans/cart-checkout.md §4.3, §4.4, §5). A server action: Next's built-in
// Origin check is the CSRF guard (plan §10). Everything that decides money, stock or the quote
// happens in @ammari/commerce's placeOrder; this wrapper adds the flag, the per-IP submit limit,
// who is asking (session or guest cart cookie), the provider runtimes, the order access cookie and
// the product page revalidation. With STOREFRONT_CART_ENABLED off nothing here touches the database.

export type PlaceOrderActionResult =
  | {
      ok: true;
      orderNo: string;
      /** The payment page to send the buyer to; null when it could not be created yet (the finish
       * page offers "Lanjutkan pembayaran"). */
      redirectUrl: string | null;
    }
  | { ok: false; message: string; fieldErrors: PlaceOrderFieldError[] };

// Loose caps that only stop an oversized payload from reaching a query; placeOrder applies the
// real rules (and their Indonesian messages).
const text = (max: number) => z.string().max(max);
const inputSchema = z.object({
  checkoutAttemptId: z.uuid(),
  contact: z.object({ email: text(320).optional(), phone: text(40) }),
  address: z.object({
    recipientName: text(300),
    phone: text(40),
    addressLine: text(1_500),
    notes: text(600).optional(),
    postalCode: text(20).optional(),
  }),
  shippingAreaId: text(64),
  voucherId: text(64).nullable(),
  termsAccepted: z.boolean(),
  promoOptIn: z.boolean(),
  expectedTotal: z.number().int().min(0).max(1_000_000_000_000),
});

export type PlaceOrderActionInput = z.input<typeof inputSchema>;

/** The page-load attempt id (a random uuid, no personal data), to match a failure to a report. */
function attemptIdForLog(input: unknown): string | undefined {
  const value = (input as { checkoutAttemptId?: unknown } | null)?.checkoutAttemptId;
  return typeof value === "string" ? value.slice(0, 36) : undefined;
}

function failure(message: string, fieldErrors: PlaceOrderFieldError[] = []): PlaceOrderActionResult {
  return { ok: false, message, fieldErrors };
}

export async function placeOrderAction(input: PlaceOrderActionInput): Promise<PlaceOrderActionResult> {
  if (!isCartEnabled()) return failure(CHECKOUT_UNAVAILABLE_MESSAGE);
  try {
    return await runPlaceOrder(input);
  } catch (error) {
    // Every expected refusal is a returned message; this is a real failure (database down, a bug),
    // database errors from the shipping quote included (plan §4.5.4). Logged by name, Postgres code
    // and constraint only: a failed query's message carries its parameters (the buyer's contact
    // and address), and nothing here may log cookies or tokens.
    console.error("[checkout] place order failed", { attempt: attemptIdForLog(input), ...databaseErrorLogFields(error) });
    return failure(CHECKOUT_GENERIC_ERROR_MESSAGE);
  }
}

async function runPlaceOrder(input: PlaceOrderActionInput): Promise<PlaceOrderActionResult> {
  const ip = await getCartClientIp("checkout submit");
  if (!ip) return failure(CHECKOUT_GENERIC_ERROR_MESSAGE);

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    // Field paths only (never values): a client and server schema drift shows up here.
    console.warn("[checkout] malformed checkout payload", { paths: parsed.error.issues.map((issue) => issue.path.join(".")) });
    return failure(CHECKOUT_INVALID_INPUT_MESSAGE);
  }

  // Fail closed before anything is written when a provider is not configured (plan §4.5.5, §12).
  const shipping = getShippingRuntime();
  if (!shipping) {
    console.warn("[checkout] refused: shipping provider not configured");
    return failure(PLACE_ORDER_MESSAGES.shipping_unavailable);
  }
  const payment = getPaymentRuntime();
  if (!payment) {
    console.warn("[checkout] refused: payment provider not configured");
    return failure(CHECKOUT_PAYMENT_UNAVAILABLE_MESSAGE);
  }

  const [session, identity, orderAccessToken] = await Promise.all([getCustomerSession(), readCartIdentity(), readOrderAccessCookie()]);
  const origin = siteOrigin();
  const result = await placeOrder(
    defaultDb,
    {
      shipping,
      payment,
      finishUrl: (orderNo) => `${origin}/checkout/finish?order=${encodeURIComponent(orderNo)}`,
      // checkout_submit (plan §5 step 1) counts only submits that passed validation and are not a
      // repeat, so correcting the form never locks a buyer out.
      admit: async () =>
        (await recordClaimAttemptAndCount(defaultDb, ip, "checkout_submit", CHECKOUT_SUBMIT_WINDOW_SECONDS)) < CHECKOUT_SUBMIT_LIMIT,
    },
    {
      customer: session ? { id: session.id, email: session.email } : null,
      guestTokenHash: identity.guestTokenHash,
      checkoutAttemptId: parsed.data.checkoutAttemptId,
      contact: parsed.data.contact,
      address: parsed.data.address,
      shippingAreaId: parsed.data.shippingAreaId,
      voucherId: parsed.data.voucherId,
      termsAccepted: parsed.data.termsAccepted,
      promoOptIn: parsed.data.promoOptIn,
      expectedTotal: parsed.data.expectedTotal,
      orderAccessToken,
    },
  );

  // Only once resolveCart has merged the guest cart into the session customer's does the guest
  // cookie name nothing (a refusal before that leaves the guest cart to merge later).
  if (result.clearGuestCookie) await clearGuestCartCookie();
  if (!result.ok) return failure(result.message, result.fieldErrors);

  // The order is committed: nothing below may turn it into a "failed" answer. Each step is
  // best-effort and logged with the order number.
  if (result.accessToken) {
    try {
      await writeOrderAccessCookie(result.accessToken);
    } catch (error) {
      console.error("[checkout] order placed but the order access cookie was not set", { orderNo: result.orderNo, ...databaseErrorLogFields(error) });
    }
  }
  // The new holds change what the storefront may show as sold out (plan §7 "Revalidation"): the
  // product pages' cached data (expired outright, see lib/content/product-data.ts), the related
  // lists and the homepage tiles (stale-while-revalidate). revalidatePath here also refreshes this
  // client's router.
  try {
    for (const slug of result.productSlugs) {
      revalidatePath(`/products/${slug}`);
      revalidateTag(productCacheTag(slug), { expire: 0 });
    }
    if (result.productSlugs.length > 0) {
      revalidateTag(PRODUCTS_CACHE_TAG, "max");
      revalidateTag(HOMEPAGE_CACHE_TAG, "max");
    }
  } catch (error) {
    console.error("[checkout] order placed but product pages were not revalidated", { orderNo: result.orderNo, ...databaseErrorLogFields(error) });
  }

  // The `created` email (plan §8), after the response; a repeat submit sends nothing new.
  scheduleOrderEmails([{ orderId: result.orderId }], "checkout");

  return { ok: true, orderNo: result.orderNo, redirectUrl: result.redirectUrl };
}
