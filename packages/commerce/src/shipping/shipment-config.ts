import "server-only";
import { normalizeIndonesianPhone } from "../address";
import type { Database } from "../db";
import { createBiteshipOrdersClient } from "./biteship-orders";
import { positiveInt, readBiteshipConnection, type ShippingEnv } from "./biteship-env";
import { DEFAULT_DAILY_SHIPPING_BUDGETS, consumeShippingCallBudget } from "./budget";
import { FAKE_ORIGIN_AREA_ID } from "./fake";
import { createFakeShipmentProvider } from "./fake-shipments";
import type { ShipmentProvider } from "./shipment-provider";
import type { ShipmentReader } from "./tracking";
import { NON_PRODUCTION_REFERENCE_PREFIXES, SHIPMENT_REFERENCE_PREFIX_PATTERN } from "./shipment-rules";

// Which courier booking provider runs, from the environment (docs/plans/cart-checkout.md §12,
// §15 Phase K). Used by apps/admin (booking, cancel, label) and apps/web (webhook, poller). Fails
// closed like the rate runtime: any missing or invalid variable gives no provider, and callers
// refuse to book or poll, naming the variables (never their values) in the log.

/** Ammari as sender (decision 50: `BITESHIP_SHIPPER_*` plus `BITESHIP_ORIGIN_AREA_ID`). */
export interface ShipmentOrigin {
  name: string;
  /** E.164 `+628...`. */
  phone: string;
  address: string;
  areaId: string;
}

export interface ShipmentRuntime {
  provider: ShipmentProvider;
  origin: ShipmentOrigin;
  /** `BITESHIP_REFERENCE_PREFIX` (decision 51). */
  referencePrefix: string;
}

export type ShipmentRuntimeResult = { ok: true; runtime: ShipmentRuntime } | { ok: false; problems: string[] };

/** The fake's sender, fictional like the fake areas. */
export const FAKE_SHIPMENT_ORIGIN: ShipmentOrigin = {
  name: "Ammari E2E",
  phone: "+6281200000001",
  address: "Jalan E2E No. 1, Kelurahan E2E",
  areaId: FAKE_ORIGIN_AREA_ID,
};

export const FAKE_SHIPMENT_REFERENCE_PREFIX = "E2E-";

/** One line, no control or invisible characters, `min` to `max` characters; null otherwise. */
function singleLine(value: string | undefined, min: number, max: number): string | null {
  if (value === undefined) return null;
  const text = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length >= min && text.length <= max ? text : null;
}

/** `SHIPPING_ORDER_PROVIDER`: `biteship` (the default) or `fake`, the fake only in an e2e run
 * (non-production build with `E2E_TEST_LOGIN=true`), like `SHIPPING_RATE_PROVIDER`. A Biteship
 * test key is refused in production and anything else outside it, so dev and local can never book
 * a real courier pickup. */
export function shipmentRuntimeFromEnv(db: Database, env: ShippingEnv): ShipmentRuntimeResult {
  const problems: string[] = [];
  const providerName = env.SHIPPING_ORDER_PROVIDER?.trim() || "biteship";

  if (providerName === "fake") {
    if (env.NODE_ENV === "production" || env.E2E_TEST_LOGIN !== "true") {
      problems.push("SHIPPING_ORDER_PROVIDER=fake is only allowed in e2e runs (non-production build with E2E_TEST_LOGIN=true)");
      return { ok: false, problems };
    }
    return { ok: true, runtime: { provider: createFakeShipmentProvider(), origin: FAKE_SHIPMENT_ORIGIN, referencePrefix: FAKE_SHIPMENT_REFERENCE_PREFIX } };
  }
  if (providerName !== "biteship") {
    problems.push("SHIPPING_ORDER_PROVIDER must be biteship or fake");
    return { ok: false, problems };
  }

  const connection = readBiteshipConnection(env, problems, { liveKeyOnlyInProduction: true });

  const name = singleLine(env.BITESHIP_SHIPPER_NAME, 2, 60);
  if (!name) problems.push("BITESHIP_SHIPPER_NAME must be 2 to 60 characters");
  const phone = env.BITESHIP_SHIPPER_PHONE ? normalizeIndonesianPhone(env.BITESHIP_SHIPPER_PHONE) : null;
  if (!phone) problems.push("BITESHIP_SHIPPER_PHONE must be an Indonesian mobile number");
  const address = singleLine(env.BITESHIP_SHIPPER_ADDRESS, 10, 300);
  if (!address) problems.push("BITESHIP_SHIPPER_ADDRESS must be 10 to 300 characters");

  // Unset or empty is allowed only in production: dev and local share one Biteship test account
  // and number their orders the same way, so each must say which one it is.
  const referencePrefix = env.BITESHIP_REFERENCE_PREFIX?.trim() ?? "";
  if (!SHIPMENT_REFERENCE_PREFIX_PATTERN.test(referencePrefix)) {
    problems.push("BITESHIP_REFERENCE_PREFIX must be A-Z, 0-9 or '-', at most 16 characters");
  } else if (referencePrefix === "" && connection && !connection.isProductionDeploy) {
    problems.push("BITESHIP_REFERENCE_PREFIX must be set outside production (e.g. DEV- or LOCAL-)");
  } else if (connection?.isProductionDeploy && NON_PRODUCTION_REFERENCE_PREFIXES.includes(referencePrefix)) {
    problems.push("BITESHIP_REFERENCE_PREFIX names a test environment but DEPLOY_ENV is production");
  }

  const ordersBudget = positiveInt(env.BITESHIP_DAILY_ORDERS_BUDGET, DEFAULT_DAILY_SHIPPING_BUDGETS.orders);
  if (ordersBudget === null) problems.push("BITESHIP_DAILY_ORDERS_BUDGET must be a positive whole number");

  if (problems.length > 0 || !connection || !name || !phone || !address || ordersBudget === null) return { ok: false, problems };

  const provider = createBiteshipOrdersClient({
    apiKey: connection.apiKey,
    baseUrl: connection.baseUrl,
    beforeRequest: (kind) => consumeShippingCallBudget(db, kind, kind === "orders" ? ordersBudget : DEFAULT_DAILY_SHIPPING_BUDGETS.order_writes),
  });
  return { ok: true, runtime: { provider, origin: { name, phone, address, areaId: connection.originAreaId }, referencePrefix } };
}

export interface TrackingRuntime {
  /** Reads only: apps/web never books or cancels. */
  reader: ShipmentReader;
}

export type TrackingRuntimeResult = { ok: true; runtime: TrackingRuntime } | { ok: false; problems: string[] };

/** The courier tracking runtime for apps/web (K3: the webhook's re-fetch and the poller; owner
 * decision 2026-10-22: read-only, so web never holds the sender's contact or the reference prefix).
 * The same key rules as the booking runtime (a test key outside production only, a live key in
 * production only), so web reads the same Biteship account admin books on, and the shared daily
 * `shipping_orders` read budget (`BITESHIP_DAILY_ORDERS_BUDGET`, set to the same value in both apps).
 * `SHIPPING_ORDER_PROVIDER=fake` only in an e2e run, reading the process's fake store. */
export function trackingRuntimeFromEnv(db: Database, env: ShippingEnv): TrackingRuntimeResult {
  const problems: string[] = [];
  const providerName = env.SHIPPING_ORDER_PROVIDER?.trim() || "biteship";

  if (providerName === "fake") {
    if (env.NODE_ENV === "production" || env.E2E_TEST_LOGIN !== "true") {
      problems.push("SHIPPING_ORDER_PROVIDER=fake is only allowed in e2e runs (non-production build with E2E_TEST_LOGIN=true)");
      return { ok: false, problems };
    }
    return { ok: true, runtime: { reader: createFakeShipmentProvider() } };
  }
  if (providerName !== "biteship") {
    problems.push("SHIPPING_ORDER_PROVIDER must be biteship or fake");
    return { ok: false, problems };
  }

  const connection = readBiteshipConnection(env, problems, { liveKeyOnlyInProduction: true });
  const ordersBudget = positiveInt(env.BITESHIP_DAILY_ORDERS_BUDGET, DEFAULT_DAILY_SHIPPING_BUDGETS.orders);
  if (ordersBudget === null) problems.push("BITESHIP_DAILY_ORDERS_BUDGET must be a positive whole number");
  if (problems.length > 0 || !connection || ordersBudget === null) return { ok: false, problems };

  const client = createBiteshipOrdersClient({
    apiKey: connection.apiKey,
    baseUrl: connection.baseUrl,
    // Only reads are ever made through this runtime; a write would still be capped like admin's.
    beforeRequest: (kind) => consumeShippingCallBudget(db, kind, kind === "orders" ? ordersBudget : DEFAULT_DAILY_SHIPPING_BUDGETS.order_writes),
  });
  return { ok: true, runtime: { reader: { name: client.name, getShipment: (providerOrderId) => client.getShipment(providerOrderId) } } };
}
