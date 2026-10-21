"use server";

import { z } from "zod";
import { getCartView } from "@ammari/commerce/cart";
import { databaseErrorLogFields } from "@ammari/commerce/checkout";
import { PLACE_ORDER_MESSAGES } from "@ammari/commerce/checkout-messages";
import { quoteShipping, type ShippingQuoteRefusal } from "@ammari/commerce/shipping";
import { isCartEnabled } from "@/lib/cart-flag";
import { getCartClientIp } from "@/lib/cart/ip";
import { clearGuestCartCookie, readCartIdentity } from "@/lib/cart/identity";
import { recordClaimAttemptAndCount } from "@/lib/claim/throttle";
import { defaultDb } from "@/lib/db";
import { getShippingRuntime } from "@/lib/shipping/runtime";
import { recordCartQuoteAndCount } from "./cart-quote-limit";
import { cartFingerprint } from "./form";
import {
  CHECKOUT_UNAVAILABLE_MESSAGE,
  SHIPPING_QUOTE_CART_LIMIT,
  SHIPPING_QUOTE_IP_LIMIT,
  SHIPPING_QUOTE_RATE_LIMITED_MESSAGE,
  SHIPPING_QUOTE_WINDOW_SECONDS,
} from "./messages";
import type { QuoteShippingActionResult, ShippingQuoteFailureKind } from "./quote-types";

// The checkout page's shipping quote (docs/plans/cart-checkout.md §4.5.4, §4.5.5, session 10):
// called when the buyer picks an area and on "Coba lagi". A server action: the browser sends only
// our own shipping_areas id; the lines come from the visitor's own cart, and every figure is the
// server's (the browser never computes or sends a price). placeOrder quotes again before it
// writes, so nothing returned here is trusted later.
//
// Two limits before the provider can be reached: per IP (`shipping_quote`, 30 per 10 minutes) and
// per cart (session 8 security review). The fake provider in e2e goes through the same path.

const inputSchema = z.object({ shippingAreaId: z.string().min(1).max(64) });

function failure(kind: ShippingQuoteFailureKind, message: string): QuoteShippingActionResult {
  return { ok: false, kind, message };
}

/** Plan §4.5.5: every provider problem is "Coba lagi"; no service and a product without a weight
 * point to WhatsApp. */
function refusalToFailure(reason: ShippingQuoteRefusal): QuoteShippingActionResult {
  switch (reason) {
    case "unknown_area":
      return failure("pick_area", PLACE_ORDER_MESSAGES.unknown_area);
    case "missing_weight":
      return failure("missing_weight", PLACE_ORDER_MESSAGES.shipping_missing_weight);
    case "empty":
      return failure("cart", PLACE_ORDER_MESSAGES.cart_empty);
    case "no_service":
      return failure("no_service", PLACE_ORDER_MESSAGES.shipping_no_service);
    case "unavailable":
    case "bad_response":
    case "budget_exhausted":
      return failure("retry", PLACE_ORDER_MESSAGES.shipping_unavailable);
    default: {
      const unhandled: never = reason;
      throw new Error(`unhandled shipping quote refusal: ${String(unhandled)}`);
    }
  }
}

export async function quoteShippingAction(input: { shippingAreaId: string }): Promise<QuoteShippingActionResult> {
  if (!isCartEnabled()) return failure("cart", CHECKOUT_UNAVAILABLE_MESSAGE);
  try {
    return await runQuote(input);
  } catch (error) {
    // Database errors (the quote's own reads included, plan §4.5.4) and bugs: logged by name and
    // Postgres code only, shown as the retry message.
    console.error("[checkout] shipping quote failed", databaseErrorLogFields(error));
    return failure("retry", PLACE_ORDER_MESSAGES.shipping_unavailable);
  }
}

async function runQuote(input: { shippingAreaId: string }): Promise<QuoteShippingActionResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return failure("pick_area", PLACE_ORDER_MESSAGES.unknown_area);

  const ip = await getCartClientIp("shipping quote");
  if (!ip) return failure("retry", PLACE_ORDER_MESSAGES.shipping_unavailable);
  const ipPrior = await recordClaimAttemptAndCount(defaultDb, ip, "shipping_quote", SHIPPING_QUOTE_WINDOW_SECONDS);
  if (ipPrior >= SHIPPING_QUOTE_IP_LIMIT) return failure("rate_limited", SHIPPING_QUOTE_RATE_LIMITED_MESSAGE);

  const view = await getCartView(defaultDb, await readCartIdentity());
  // The read merged a guest cart into the session customer's: the guest cookie names nothing now.
  if (view.clearGuestCookie) await clearGuestCartCookie();
  if (!view.cartId || view.lines.length === 0) return failure("cart", PLACE_ORDER_MESSAGES.cart_empty);
  if (!view.canCheckout) return failure("cart", PLACE_ORDER_MESSAGES.cart_unavailable);

  const cartPrior = await recordCartQuoteAndCount(defaultDb, view.cartId, SHIPPING_QUOTE_WINDOW_SECONDS);
  if (cartPrior >= SHIPPING_QUOTE_CART_LIMIT) {
    console.warn("[checkout] shipping quote refused: per-cart limit", { cartId: view.cartId });
    return failure("rate_limited", SHIPPING_QUOTE_RATE_LIMITED_MESSAGE);
  }

  const runtime = getShippingRuntime();
  if (!runtime) return failure("retry", PLACE_ORDER_MESSAGES.shipping_unavailable);

  const result = await quoteShipping(defaultDb, runtime, {
    areaId: parsed.data.shippingAreaId,
    lines: view.lines.map((line) => ({ sku: line.sku, qty: line.qty })),
  });
  if (!result.ok) return refusalToFailure(result.reason);

  const { quote } = result;
  return {
    ok: true,
    quote: { label: quote.label, costAmount: quote.costAmount, subsidyAmount: quote.subsidyAmount, buyerAmount: quote.buyerAmount },
    subtotal: view.subtotal,
    cartKey: cartFingerprint(view.lines, view.subtotal),
  };
}
