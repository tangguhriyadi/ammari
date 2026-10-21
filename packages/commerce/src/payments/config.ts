import "server-only";
import { DEFAULT_STOCK_HOLD_MINUTES } from "../stock/reservations";
import { createFakePaymentProvider } from "./fake";
import { PAYMENT_ORDER_ID_PREFIX_PATTERN } from "./lines";
import { createMidtransPaymentProvider } from "./midtrans";
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
 * `SHIPPING_RATE_PROVIDER=fake`), so a deployed container can never take fake payments.
 *
 * Midtrans needs `MIDTRANS_SERVER_KEY` and an explicit `MIDTRANS_IS_PRODUCTION` (`true` / `false`);
 * `MIDTRANS_NOTIFICATION_URL` is optional (sent as X-Override-Notification, D8; https only). Real
 * money only where it belongs: the production environment (`DEPLOY_ENV=production`, or a production
 * build that does not say which environment it is) must use production mode, and production mode
 * is refused everywhere else; a sandbox key (`SB-` prefix, Midtrans' sandbox key convention) is
 * refused in production mode. */
/** Only the provider (no checkout timing or prefix), for the notification route: a bad checkout
 * variable must never stop a paid notification from being verified and applied. */
export function paymentProviderFromEnv(env: PaymentEnv, options: { siteOrigin: string }): { ok: true; provider: PaymentProvider } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const providerName = env.PAYMENT_PROVIDER?.trim() || "midtrans";
  let provider: PaymentProvider | null = null;
  if (providerName === "fake") {
    if (env.NODE_ENV === "production" || env.E2E_TEST_LOGIN !== "true") {
      problems.push("PAYMENT_PROVIDER=fake is only allowed in e2e runs (non-production build with E2E_TEST_LOGIN=true)");
    } else {
      provider = createFakePaymentProvider({ baseUrl: options.siteOrigin });
    }
  } else if (providerName === "midtrans") {
    provider = midtransFromEnv(env, problems);
  } else {
    problems.push("PAYMENT_PROVIDER must be midtrans or fake");
  }
  return provider && problems.length === 0 ? { ok: true, provider } : { ok: false, problems };
}

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

  const providerResult = paymentProviderFromEnv(env, options);
  if (!providerResult.ok) problems.push(...providerResult.problems);
  const provider = providerResult.ok ? providerResult.provider : null;

  if (problems.length > 0 || !provider || paymentExpiryMinutes === null || stockHoldMinutes === null) return { ok: false, problems };
  return { ok: true, runtime: { provider, orderIdPrefix, paymentExpiryMinutes, stockHoldMinutes } };
}

const NOTIFICATION_URL_MAX = 255;

function midtransFromEnv(env: PaymentEnv, problems: string[]): PaymentProvider | null {
  const before = problems.length;
  const serverKey = env.MIDTRANS_SERVER_KEY?.trim() ?? "";
  if (serverKey === "") problems.push("MIDTRANS_SERVER_KEY is not set");
  else if (!/^[A-Za-z0-9_-]{10,200}$/.test(serverKey)) problems.push("MIDTRANS_SERVER_KEY has an unexpected format");

  const mode = env.MIDTRANS_IS_PRODUCTION?.trim();
  if (mode !== "true" && mode !== "false") problems.push("MIDTRANS_IS_PRODUCTION must be true or false");
  const isProduction = mode === "true";
  // Fails closed when a production build does not say which environment it is (same rule as the
  // Biteship test-key guard).
  const deployEnv = env.DEPLOY_ENV?.trim();
  // An allowlist, failing closed: a typo (`prod`, `Production`) must not let prod run in sandbox mode.
  if (deployEnv !== undefined && deployEnv !== "" && !["production", "dev", "development", "test"].includes(deployEnv)) {
    problems.push("DEPLOY_ENV must be production, dev, development or test");
  }
  const isProductionDeploy = deployEnv === "production" || (env.NODE_ENV === "production" && !deployEnv);
  if (isProductionDeploy && mode === "false") problems.push("MIDTRANS_IS_PRODUCTION must be true when DEPLOY_ENV is production or unset");
  if (!isProductionDeploy && isProduction) problems.push("MIDTRANS_IS_PRODUCTION=true is only allowed when DEPLOY_ENV is production");
  if (isProduction && serverKey.startsWith("SB-")) problems.push("MIDTRANS_SERVER_KEY is a sandbox key but MIDTRANS_IS_PRODUCTION is true");

  let notificationUrl: string | null = null;
  const rawUrl = env.MIDTRANS_NOTIFICATION_URL?.trim() ?? "";
  if (rawUrl !== "") {
    let parsed: URL | null = null;
    try {
      parsed = new URL(rawUrl);
    } catch {
      parsed = null;
    }
    // One URL (the header takes a comma-separated list), https, inside Midtrans' 255 characters.
    if (!parsed || parsed.protocol !== "https:" || rawUrl.includes(",") || rawUrl.length > NOTIFICATION_URL_MAX || parsed.username || parsed.password) {
      problems.push("MIDTRANS_NOTIFICATION_URL must be one https URL of at most 255 characters");
    } else {
      notificationUrl = parsed.toString();
    }
  }

  if (problems.length > before) return null;
  return createMidtransPaymentProvider({ serverKey, isProduction, notificationUrl });
}
