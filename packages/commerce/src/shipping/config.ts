import "server-only";
import type { Database } from "../db";
import { readDeployEnv } from "../deploy-env";
import { createBiteshipClient } from "./biteship";
import { DEFAULT_DAILY_SHIPPING_BUDGETS, consumeShippingCallBudget } from "./budget";
import { DEFAULT_SHIPPING_QUOTE_CACHE_MINUTES } from "./cache";
import { FAKE_ORIGIN_AREA_ID, createFakeShippingRateProvider } from "./fake";
import type { ShippingRateProvider } from "./provider";
import type { ShippingQuoteDeps } from "./quote";

// Which rate provider runs, from the environment (docs/plans/cart-checkout.md §12). Fails closed:
// a missing or invalid variable gives no provider, and callers answer "unavailable" (§4.5.5). The
// real Biteship client is built only when its key, base URL and origin are all set.

export type ShippingEnv = Readonly<Record<string, string | undefined>>;

export interface ShippingRuntime extends ShippingQuoteDeps {
  provider: ShippingRateProvider;
}

export type ShippingRuntimeResult =
  | { ok: true; runtime: ShippingRuntime }
  /** `problems` names variables only, never their values: safe to log. */
  | { ok: false; problems: string[] };

/** The fallback when unset, the number when it is plain digits above 0, otherwise null (a
 * problem). "1e3", "0x10" and "12.5" are refused. */
function positiveInt(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value.trim() === "") return fallback;
  const text = value.trim();
  if (!/^[0-9]{1,9}$/.test(text)) return null;
  const parsed = Number(text);
  return parsed > 0 ? parsed : null;
}

/** The only host the Biteship key is ever sent to. */
const BITESHIP_HOST = "api.biteship.com";

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

  const apiKey = env.BITESHIP_API_KEY?.trim();
  const baseUrl = env.BITESHIP_BASE_URL?.trim();
  const originAreaId = env.BITESHIP_ORIGIN_AREA_ID?.trim();
  // An allowlist, failing closed like the payment guard: a typo never unlocks a test key in prod.
  const { isProductionDeploy, problem: deployEnvProblem } = readDeployEnv(env);
  if (deployEnvProblem) problems.push(deployEnvProblem);
  if (!apiKey) problems.push("BITESHIP_API_KEY is not set");
  else if (apiKey.startsWith("biteship_test.") && isProductionDeploy) {
    // Fails closed when a production build does not say which environment it is.
    problems.push("BITESHIP_API_KEY is a test key but DEPLOY_ENV is production or unset");
  }
  if (!baseUrl) problems.push("BITESHIP_BASE_URL is not set");
  else {
    let url: URL | null = null;
    try {
      url = new URL(baseUrl);
    } catch {
      url = null;
    }
    // The key travels in a header, so only Biteship's own host, over https, with nothing else in
    // the URL (no credentials, query or fragment).
    if (!url || url.protocol !== "https:" || url.hostname !== BITESHIP_HOST || url.port !== "" || url.username || url.password || url.search || url.hash) {
      problems.push(`BITESHIP_BASE_URL must be https://${BITESHIP_HOST}`);
    }
  }
  if (!originAreaId) problems.push("BITESHIP_ORIGIN_AREA_ID is not set");

  const mapsBudget = positiveInt(env.BITESHIP_DAILY_MAPS_BUDGET, DEFAULT_DAILY_SHIPPING_BUDGETS.maps);
  const ratesBudget = positiveInt(env.BITESHIP_DAILY_RATES_BUDGET, DEFAULT_DAILY_SHIPPING_BUDGETS.rates);
  if (mapsBudget === null) problems.push("BITESHIP_DAILY_MAPS_BUDGET must be a positive whole number");
  if (ratesBudget === null) problems.push("BITESHIP_DAILY_RATES_BUDGET must be a positive whole number");

  if (problems.length > 0 || !apiKey || !baseUrl || !originAreaId || cacheMinutes === null || mapsBudget === null || ratesBudget === null) {
    return { ok: false, problems };
  }

  const provider = createBiteshipClient({
    apiKey,
    baseUrl,
    beforeRequest: (kind) => consumeShippingCallBudget(db, kind, kind === "maps" ? mapsBudget : ratesBudget),
  });
  return { ok: true, runtime: { provider, originAreaId, cacheMinutes } };
}
