import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { carts, claimRateLimits, customerLoginLinks, orderAccessTokens, paymentNotifications, shippingRateCache, shippingWebhookEvents, tiktokWebhookEvents } from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";
import type { Database } from "../db";
import { errorLogFields } from "../errors";

// The daily retention job (docs/plans/cart-checkout.md §11, session 12 scope confirmed by the owner
// 2026-10-21), run by the internal cron service through apps/web's `POST /api/internal/retention`.
// Deletes only rows that are past their retention and no code reads any more:
// - `payment_notifications` older than 12 months (the raw log, verified or not);
// - `claim_rate_limits` older than 1 day: every per-IP limit (longest window 1 hour), the shipping
//   provider's daily budgets under ip 0.0.0.0 (counted per Jakarta day, so never older than 24
//   hours when counted) and the per-cart quote limit rows (`shipping_quote_cart:<cart id>`);
// - `shipping_rate_cache` rows fetched more than 7 days ago (only fresh rows are ever used);
// - guest carts 30 days and customer carts 180 days after their last activity (every cart write
//   bumps it; lines go with the cart, ON DELETE CASCADE);
// - `order_access_tokens` 30 days after they expired;
// - `customer_login_links` 30 days after they expired (session 14; a used link was used before it
//   expired, so this is also more than 30 days after its use; the login itself stays in audit_log);
// - `shipping_webhook_events` older than 12 months (K3, the raw courier webhook log; the tracking
//   events themselves stay with the order in `shipment_events`);
// - `tiktok_webhook_events` older than 12 months (docs/plans/tiktok-shop-integration.md §3.2, T3:
//   the verified, allowlisted TikTok webhook inbox; the orders themselves come from the poll).
// Not a delete, but on the same daily run: `tiktok_orders.buyer_message` is set to NULL once
// `buyer_message_purge_after` (TikTok's COMPLETED/CANCELLED + 30 days) has passed, only while the
// order is still COMPLETED or CANCELLED (an open order's note is never purged; plan §3.3, §6, Q14, T4).
// Not here (later sessions): anonymizing unpaid orders after 90 days and paid ones after 10 years.
//
// Each table is deleted in batches of RETENTION_BATCH_SIZE rows, each batch its own statement, so
// no delete holds many row locks for long or scans the whole backlog. The batch is picked with
// FOR UPDATE SKIP LOCKED: a row a writer holds (a cart being written to, which bumps its last
// activity) is skipped, and a row locked after waiting is re-checked against the age condition
// (READ COMMITTED re-evaluates it on the new row version), so a cart touched meanwhile is kept.

export const RETENTION_BATCH_SIZE = 5_000;
/** Batches per table per run; anything left is deleted by the next run. */
const MAX_BATCHES = 100;

export const RETENTION_RULES = [
  { name: "payment_notifications", table: paymentNotifications, condition: sql`${paymentNotifications.receivedAt} < now() - interval '12 months'` },
  { name: "claim_rate_limits", table: claimRateLimits, condition: sql`${claimRateLimits.createdAt} < now() - interval '1 day'` },
  { name: "shipping_rate_cache", table: shippingRateCache, condition: sql`${shippingRateCache.fetchedAt} < now() - interval '7 days'` },
  { name: "guest_carts", table: carts, condition: sql`${carts.customerId} is null and ${carts.lastActivityAt} < now() - interval '30 days'` },
  { name: "customer_carts", table: carts, condition: sql`${carts.customerId} is not null and ${carts.lastActivityAt} < now() - interval '180 days'` },
  { name: "order_access_tokens", table: orderAccessTokens, condition: sql`${orderAccessTokens.expiresAt} < now() - interval '30 days'` },
  { name: "customer_login_links", table: customerLoginLinks, condition: sql`${customerLoginLinks.expiresAt} < now() - interval '30 days'` },
  { name: "shipping_webhook_events", table: shippingWebhookEvents, condition: sql`${shippingWebhookEvents.receivedAt} < now() - interval '12 months'` },
  { name: "tiktok_webhook_events", table: tiktokWebhookEvents, condition: sql`${tiktokWebhookEvents.receivedAt} < now() - interval '12 months'` },
] as const satisfies readonly { name: string; table: { id: unknown }; condition: SQL }[];

export type RetentionRuleName = (typeof RETENTION_RULES)[number]["name"];

export interface RetentionSummary {
  deleted: Record<RetentionRuleName, number>;
  /** Rules that stopped at MAX_BATCHES (the rest goes next run). */
  truncated: (RetentionRuleName | "tiktok_buyer_messages")[];
  /** Rules whose delete failed (logged); the others still ran. */
  failed: (RetentionRuleName | "tiktok_buyer_messages")[];
  /** Values cleared in place (not rows deleted). */
  purged: { tiktok_buyer_messages: number };
}

/** Clears TikTok buyer messages past their purge date, in batches like the deletes. */
export async function purgeTikTokBuyerMessages(db: Database, options: { batchSize?: number; maxBatches?: number } = {}): Promise<{ purged: number; truncated: boolean }> {
  const batchSize = options.batchSize ?? RETENTION_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? MAX_BATCHES;
  let purged = 0;
  for (let batch = 1; ; batch += 1) {
    const rows = await db.execute<{ purged: number }>(sql`
      with picked as (
        select tiktok_order_id from tiktok_orders
        where buyer_message is not null and buyer_message_purge_after <= now() and status in ('COMPLETED', 'CANCELLED')
        limit ${batchSize} for update skip locked
      ), done as (
        update tiktok_orders t set buyer_message = null, updated_at = now()
        from picked where t.tiktok_order_id = picked.tiktok_order_id
          and t.buyer_message_purge_after <= now() and t.status in ('COMPLETED', 'CANCELLED')
        returning 1
      )
      select count(*)::int as purged from done
    `);
    const count = Number(rows[0]?.purged ?? 0);
    purged += count;
    if (count < batchSize) return { purged, truncated: false };
    if (batch >= maxBatches) return { purged, truncated: true };
  }
}

async function deleteBatch(db: Database, rule: (typeof RETENTION_RULES)[number], batchSize: number): Promise<number> {
  // Pick at most one batch (row-locked, skipping rows a writer holds right now), then delete
  // exactly those: each statement touches at most `batchSize` rows however large the backlog.
  const rows = await db.execute<{ deleted: number }>(sql`
    with picked as (
      select ${rule.table.id} as id from ${rule.table} where ${rule.condition} limit ${batchSize} for update skip locked
    ), gone as (
      delete from ${rule.table} using picked where ${qualifiedColumn(rule.table, rule.table.id)} = picked.id
      returning 1
    )
    select count(*)::int as deleted from gone
  `);
  return Number(rows[0]?.deleted ?? 0);
}

/** One retention run. The caller holds the run lock (withExclusiveRun). Never throws for one
 * table's failure: it is logged (name and Postgres code only) and the other tables still run. */
export async function runRetention(db: Database, options: { batchSize?: number; maxBatches?: number } = {}): Promise<RetentionSummary> {
  const batchSize = options.batchSize ?? RETENTION_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? MAX_BATCHES;
  const summary: RetentionSummary = {
    deleted: Object.fromEntries(RETENTION_RULES.map((rule) => [rule.name, 0])) as Record<RetentionRuleName, number>,
    truncated: [],
    failed: [],
    purged: { tiktok_buyer_messages: 0 },
  };
  for (const rule of RETENTION_RULES) {
    try {
      for (let batch = 1; ; batch += 1) {
        const deleted = await deleteBatch(db, rule, batchSize);
        summary.deleted[rule.name] += deleted;
        if (deleted < batchSize) break;
        if (batch >= maxBatches) {
          summary.truncated.push(rule.name);
          break;
        }
      }
    } catch (error) {
      console.error("[retention] delete failed; other tables still run", { rule: rule.name, ...errorLogFields(error) });
      summary.failed.push(rule.name);
    }
  }
  try {
    const result = await purgeTikTokBuyerMessages(db, { batchSize, maxBatches });
    summary.purged.tiktok_buyer_messages = result.purged;
    if (result.truncated) summary.truncated.push("tiktok_buyer_messages");
  } catch (error) {
    console.error("[retention] TikTok buyer message purge failed; the deletes still ran", { rule: "tiktok_buyer_messages", ...errorLogFields(error) });
    summary.failed.push("tiktok_buyer_messages");
  }
  return summary;
}
