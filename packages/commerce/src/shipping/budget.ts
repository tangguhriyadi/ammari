import "server-only";
import { sql } from "drizzle-orm";
import { claimRateLimits } from "@ammari/db/schema";
import type { Database } from "../db";
import { ShippingRateError, type ShippingCallKind } from "./provider";
import type { ShipmentCallKind } from "./shipment-provider";

// The global daily provider budgets (docs/plans/cart-checkout.md §4.5.4). Biteship's quotas are
// monthly and overage is billed per request, so a daily cap per Jakarta day keeps a bot from
// spending a month's quota (or real money) in one day. Every outgoing request, retries included,
// records one claim_rate_limits row first. ip is the fixed 0.0.0.0 (the column is inet, so the
// plan's `*` is not storable); no real client ever has that address.

export const SHIPPING_BUDGET_IP = "0.0.0.0";

/** Every budgeted Biteship call: Maps and Rates (checkout), order reads and order writes (Phase K). */
export type ShippingBudgetKind = ShippingCallKind | ShipmentCallKind;

export const SHIPPING_BUDGET_ACTIONS: Record<ShippingBudgetKind, string> = {
  maps: "shipping_maps",
  rates: "shipping_rates",
  orders: "shipping_orders",
  order_writes: "shipping_order_writes",
};

/** Used when the env does not set one. Maps and Rates: Grow plan monthly quotas / 31 (Maps 50.000,
 * Rates 10.000). Order reads (webhook re-fetches and the poller, decision 48): Grow's Tracking
 * quota 2.000 / 31, assuming `GET /v1/orders/:id` counts against it (undocumented). Order writes
 * (bookings and cancels by staff): a safety cap only, far above a day's packing; not configurable. */
export const DEFAULT_DAILY_SHIPPING_BUDGETS: Record<ShippingBudgetKind, number> = {
  maps: 1_500,
  rates: 300,
  orders: 60,
  order_writes: 200,
};

/** Records one request of `kind` and refuses it (`budget_exhausted`) when `dailyLimit` requests
 * were already recorded today (Asia/Jakarta). The insert and the count are one statement, the same
 * idiom as recordClaimAttemptAndCount: the count sees the requests committed before it, so two
 * requests racing at the very edge can both pass. That overshoot of a few calls is fine for a
 * spending cap; nothing here guards stock or money. */
export async function consumeShippingCallBudget(db: Database, kind: ShippingBudgetKind, dailyLimit: number): Promise<void> {
  const action = SHIPPING_BUDGET_ACTIONS[kind];
  const [row] = await db
    .insert(claimRateLimits)
    .values({ ip: SHIPPING_BUDGET_IP, action })
    .returning({
      prior: sql<number>`(
        select count(*) from ${claimRateLimits}
        where ${claimRateLimits.ip} = ${SHIPPING_BUDGET_IP}::inet
          and ${claimRateLimits.action} = ${action}
          and ${claimRateLimits.createdAt} >= (date_trunc('day', now() at time zone 'Asia/Jakarta') at time zone 'Asia/Jakarta')
      )`,
    });
  // INSERT ... RETURNING always yields the row; if it ever did not, refuse rather than allow.
  if (!row) throw new ShippingRateError("budget_exhausted", `daily ${kind} budget could not be recorded`);
  const prior = Number(row.prior);
  // Fails closed: a count we cannot read never lets the request through.
  if (!Number.isFinite(prior) || prior >= dailyLimit) {
    throw new ShippingRateError("budget_exhausted", `daily ${kind} budget of ${dailyLimit} requests used up`);
  }
}
