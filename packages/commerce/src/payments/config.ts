import "server-only";
import { DEFAULT_STOCK_HOLD_MINUTES } from "../stock/reservations";
import { createFakePaymentProvider } from "./fake";
import { PAYMENT_ORDER_ID_PREFIX_PATTERN } from "./lines";
import type { PaymentProvider } from "./provider";

// Which payment provider runs, and the checkout timing, from the environment
// (docs/plans/cart-checkout.md §12). Fails closed like the shipping runtime: a missing or invalid
// variable gives no runtime, and checkout refuses before creating anything.

export type PaymentEnv = Readonly<Record<string, string | undefined>>;

/** Owner decision 1: the payment window is 60 minutes (the stock hold is 75). */
export const DEFAULT_PAYMENT_EXPIRY_MINUTES = 60;
const MAX_MINUTES = 24 * 60;

export interface PaymentRuntime {
  provider: PaymentProvider;
  /** `MIDTRANS_ORDER_ID_PREFIX` (D7). */
  orderIdPrefix: string;
  /** `CHECKOUT_PAYMENT_EXPIRY_MINUTES`. */
  paymentExpiryMinutes: number;
  /** `CHECKOUT_STOCK_HOLD_MINUTES`; always longer than the payment window, so a buyer who pays at
   * the last minute still has their pieces held. */
  stockHoldMinutes: number;
}

export type PaymentRuntimeResult =
  | { ok: true; runtime: PaymentRuntime }
  /** Variable names only, never values: safe to log. */
  | { ok: false; problems: string[] };

function minutes(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value.trim() === "") return fallback;
  const text = value.trim();
  if (!/^[0-9]{1,4}$/.test(text)) return null;
  const parsed = Number(text);
  return parsed >= 1 && parsed <= MAX_MINUTES ? parsed : null;
}

/** `PAYMENT_PROVIDER`: `midtrans` (the default) or `fake`. The fake is accepted only outside a
 * production build and with `E2E_TEST_LOGIN=true` (the e2e fixtures gate, same as
 * `SHIPPING_RATE_PROVIDER=fake`), so a deployed container can never take fake payments. Midtrans
 * itself arrives in session 11; until then `midtrans` reports itself as not configured. */
export function paymentRuntimeFromEnv(env: PaymentEnv, options: { siteOrigin: string }): PaymentRuntimeResult {
  const problems: string[] = [];

  const paymentExpiryMinutes = minutes(env.CHECKOUT_PAYMENT_EXPIRY_MINUTES, DEFAULT_PAYMENT_EXPIRY_MINUTES);
  const stockHoldMinutes = minutes(env.CHECKOUT_STOCK_HOLD_MINUTES, DEFAULT_STOCK_HOLD_MINUTES);
  if (paymentExpiryMinutes === null) problems.push(`CHECKOUT_PAYMENT_EXPIRY_MINUTES must be a whole number of minutes from 1 to ${MAX_MINUTES}`);
  if (stockHoldMinutes === null) problems.push(`CHECKOUT_STOCK_HOLD_MINUTES must be a whole number of minutes from 1 to ${MAX_MINUTES}`);
  if (paymentExpiryMinutes !== null && stockHoldMinutes !== null && stockHoldMinutes <= paymentExpiryMinutes) {
    problems.push("CHECKOUT_STOCK_HOLD_MINUTES must be longer than CHECKOUT_PAYMENT_EXPIRY_MINUTES");
  }

  const orderIdPrefix = env.MIDTRANS_ORDER_ID_PREFIX?.trim() ?? "";
  if (!PAYMENT_ORDER_ID_PREFIX_PATTERN.test(orderIdPrefix)) problems.push("MIDTRANS_ORDER_ID_PREFIX must be A-Z, 0-9 or '-', at most 16 characters");

  const providerName = env.PAYMENT_PROVIDER?.trim() || "midtrans";
  let provider: PaymentProvider | null = null;
  if (providerName === "fake") {
    if (env.NODE_ENV === "production" || env.E2E_TEST_LOGIN !== "true") {
      problems.push("PAYMENT_PROVIDER=fake is only allowed in e2e runs (non-production build with E2E_TEST_LOGIN=true)");
    } else {
      provider = createFakePaymentProvider({ baseUrl: options.siteOrigin });
    }
  } else if (providerName === "midtrans") {
    problems.push("PAYMENT_PROVIDER=midtrans is not available yet (plan session 11)");
  } else {
    problems.push("PAYMENT_PROVIDER must be midtrans or fake");
  }

  if (problems.length > 0 || !provider || paymentExpiryMinutes === null || stockHoldMinutes === null) return { ok: false, problems };
  return { ok: true, runtime: { provider, orderIdPrefix, paymentExpiryMinutes, stockHoldMinutes } };
}
