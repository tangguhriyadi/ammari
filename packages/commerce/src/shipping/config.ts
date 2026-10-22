import "server-only";
import type { Database } from "../db";
import { createBiteshipClient } from "./biteship";
import { positiveInt, readBiteshipConnection, type ShippingEnv } from "./biteship-env";
import { DEFAULT_DAILY_SHIPPING_BUDGETS, consumeShippingCallBudget } from "./budget";
import { DEFAULT_SHIPPING_QUOTE_CACHE_MINUTES } from "./cache";
import { FAKE_ORIGIN_AREA_ID, createFakeShippingRateProvider } from "./fake";
import type { ShippingRateProvider } from "./provider";
import type { ShippingQuoteDeps } from "./quote";

// Which rate provider runs, from the environment (docs/plans/cart-checkout.md §12). Fails closed:
// a missing or invalid variable gives no provider, and callers answer "unavailable" (§4.5.5). The
// real Biteship client is built only when its key, base URL and origin are all set.

export type { ShippingEnv } from "./biteship-env";

export interface ShippingRuntime extends ShippingQuoteDeps {
  provider: ShippingRateProvider;
}

export type ShippingRuntimeResult =
  | { ok: true; runtime: ShippingRuntime }
  /** `problems` names variables only, never their values: safe to log. */
  | { ok: false; problems: string[] };

/** `SHIPPING_RATE_PROVIDER`: `biteship` (the default) or `fake`. The fake is accepted only outside a
 * production build and with `E2E_TEST_LOGIN=true`, the same gate as the e2e fixtures route, so a
 * deployed container (NODE_ENV=production on dev and prod) can never quote fictional prices. */
export function shippingRuntimeFromEnv(db: Database, env: ShippingEnv): ShippingRuntimeResult {
  const problems: string[] = [];
  const cacheMinutes = positiveInt(env.SHIPPING_QUOTE_CACHE_MINUTES, DEFAULT_SHIPPING_QUOTE_CACHE_MINUTES);
  if (cacheMinutes === null) problems.push("SHIPPING_QUOTE_CACHE_MINUTES must be a positive whole number of minutes");

  const providerName = env.SHIPPING_RATE_PROVIDER?.trim() || "biteship";

  if (providerName === "fake") {
    if (env.NODE_ENV === "production" || env.E2E_TEST_LOGIN !== "true") {
      problems.push("SHIPPING_RATE_PROVIDER=fake is only allowed in e2e runs (non-production build with E2E_TEST_LOGIN=true)");
    }
    if (problems.length > 0 || cacheMinutes === null) return { ok: false, problems };
    return { ok: true, runtime: { provider: createFakeShippingRateProvider(), originAreaId: FAKE_ORIGIN_AREA_ID, cacheMinutes } };
  }

  if (providerName !== "biteship") {
    problems.push("SHIPPING_RATE_PROVIDER must be biteship or fake");
    return { ok: false, problems };
  }

  const connection = readBiteshipConnection(env, problems);

  const mapsBudget = positiveInt(env.BITESHIP_DAILY_MAPS_BUDGET, DEFAULT_DAILY_SHIPPING_BUDGETS.maps);
  const ratesBudget = positiveInt(env.BITESHIP_DAILY_RATES_BUDGET, DEFAULT_DAILY_SHIPPING_BUDGETS.rates);
  if (mapsBudget === null) problems.push("BITESHIP_DAILY_MAPS_BUDGET must be a positive whole number");
  if (ratesBudget === null) problems.push("BITESHIP_DAILY_RATES_BUDGET must be a positive whole number");

  if (problems.length > 0 || !connection || cacheMinutes === null || mapsBudget === null || ratesBudget === null) {
    return { ok: false, problems };
  }

  const { apiKey, baseUrl, originAreaId } = connection;
  const provider = createBiteshipClient({
    apiKey,
    baseUrl,
    beforeRequest: (kind) => consumeShippingCallBudget(db, kind, kind === "maps" ? mapsBudget : ratesBudget),
  });
  return { ok: true, runtime: { provider, originAreaId, cacheMinutes } };
}
