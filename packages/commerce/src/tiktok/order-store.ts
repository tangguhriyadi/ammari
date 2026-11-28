import "server-only";
import { sql } from "drizzle-orm";
import type { TikTokSnapshotSource } from "@ammari/db/schema";
import type { AllowlistedObject, TikTokOrderProjection } from "@ammari/tiktok-shop";
import { writeAuditLog, type Database, type Tx } from "../db";

// Versioned TikTok order snapshots and the current-state projection (docs/plans/
// tiktok-shop-integration.md §3.3, §4.1 step 3, §6; T4). Read side only: nothing here writes an
// admin order, a stock movement or a journal (T5 does that, through transitionOrderStatus and the
// stock ledger).
//
// One transaction per order, under `pg_advisory_xact_lock(hashtext('tiktok-order:' || id))` (the
// same key T5's commit takes), so the webhook drain and the cron poll storing the same order run
// one after the other:
//   1. the snapshot: `INSERT ... ON CONFLICT (tiktok_order_id, update_time, content_sha256) DO
//      NOTHING RETURNING`: a replay of the same version is a no-op;
//   2. a second snapshot with the same `update_time` but different content is kept and the order is
//      flagged `tiktok_snapshot_conflict` (never silently chosen);
//   3. the projection: `INSERT ... ON CONFLICT DO UPDATE ... WHERE latest_update_time < $new`: it
//      only moves forward, so an older snapshot arriving late never overwrites a newer one;
//   4. the auto-map of seller SKUs that exactly match an active Ammari SKU (§3.3).
// `buyer_message` goes only to the projection, and never again once its purge date has passed.

export const TIKTOK_TERMINAL_STATUSES = ["COMPLETED", "CANCELLED"] as const;
/** Q14: the buyer message is cleared 30 days after TikTok reports COMPLETED or CANCELLED. */
export const TIKTOK_BUYER_MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const ENTITY_SKU_MAPPING = "tiktok_sku_mapping";

export type TikTokSnapshotOutcome = "inserted" | "replay" | "conflict";
export type TikTokProjectionOutcome = "created" | "advanced" | "unchanged";

export interface IngestTikTokOrderResult {
  snapshot: TikTokSnapshotOutcome;
  projection: TikTokProjectionOutcome;
  /** TikTok SKU ids auto-mapped by this call. */
  autoMapped: string[];
}

function isTerminal(status: string): boolean {
  return (TIKTOK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** When the buyer message may be purged: the terminal time + 30 days, or null for an open order. */
export function tiktokBuyerMessagePurgeAfter(order: Pick<TikTokOrderProjection, "status" | "updateTime" | "cancelTime">): Date | null {
  if (!isTerminal(order.status)) return null;
  const terminalAt = order.status === "CANCELLED" ? (order.cancelTime ?? order.updateTime) : order.updateTime;
  return new Date(terminalAt.getTime() + TIKTOK_BUYER_MESSAGE_RETENTION_MS);
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/** `backfillId` (T9): the backfill storing this order. Set on the projection only when the backfill is
 * the first to store the order (the gate: apply.ts waits for "Terapkan riwayat"). A later live store
 * (poll, webhook) never lifts it: nothing the preview lists changes before the owner confirms. */
export async function ingestTikTokOrder(db: Database, order: TikTokOrderProjection, source: TikTokSnapshotSource, now: Date = new Date(), options: { backfillId?: string | null } = {}): Promise<IngestTikTokOrderResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tiktok-order:${order.tiktokOrderId}`}))`);
    const updateTime = order.updateTime.toISOString();
    const backfillId = source === "backfill" ? (options.backfillId ?? null) : null;

    const inserted = await tx.execute<{ id: string }>(sql`
      insert into tiktok_order_snapshots (tiktok_order_id, update_time, content_sha256, payload, source, kind, fetched_at)
      values (${order.tiktokOrderId}, ${updateTime}::timestamptz, ${order.contentSha256}, ${JSON.stringify(order.payload)}::jsonb, ${source}, 'order', ${now.toISOString()}::timestamptz)
      on conflict (tiktok_order_id, update_time, content_sha256) do nothing
      returning id
    `);
    const snapshotId = inserted[0]?.id;
    const autoMapped = await autoMapTikTokSkus(tx, order.payload);
    if (!snapshotId) return { snapshot: "replay", projection: "unchanged", autoMapped };

    const [conflict] = await tx.execute<{ conflict: boolean }>(sql`
      select exists (
        select 1 from tiktok_order_snapshots
        where tiktok_order_id = ${order.tiktokOrderId} and kind = 'order' and update_time = ${updateTime}::timestamptz and content_sha256 <> ${order.contentSha256}
      ) as conflict
    `);
    const isConflict = conflict?.conflict === true;

    const purgeAfter = tiktokBuyerMessagePurgeAfter(order);
    // An order first seen already past its purge date (a late first poll, a backfill) never stores it.
    const firstMessage = purgeAfter !== null && purgeAfter.getTime() <= now.getTime() ? null : order.buyerMessage;
    const terminal = sql.raw(TIKTOK_TERMINAL_STATUSES.map((status) => `'${status}'`).join(", "));
    const projected = await tx.execute<{ created: boolean }>(sql`
      insert into tiktok_orders as t (
        tiktok_order_id, status, latest_update_time, latest_snapshot_id, paid_time, collection_time, delivery_time, cancel_time,
        is_on_hold_order, rts_sla_time, buyer_message, buyer_message_purge_after, first_seen_at, backfill_id
      ) values (
        ${order.tiktokOrderId}, ${order.status}, ${updateTime}::timestamptz, ${snapshotId}::uuid, ${iso(order.paidTime)}::timestamptz,
        ${iso(order.collectionTime)}::timestamptz, ${iso(order.deliveryTime)}::timestamptz, ${iso(order.cancelTime)}::timestamptz,
        ${order.isOnHoldOrder}, ${iso(order.rtsSlaTime)}::timestamptz, ${firstMessage}, ${iso(purgeAfter)}::timestamptz, ${now.toISOString()}::timestamptz,
        ${backfillId}::uuid
      )
      on conflict (tiktok_order_id) do update set
        status = excluded.status,
        latest_update_time = excluded.latest_update_time,
        latest_snapshot_id = excluded.latest_snapshot_id,
        paid_time = excluded.paid_time,
        collection_time = excluded.collection_time,
        delivery_time = excluded.delivery_time,
        cancel_time = excluded.cancel_time,
        is_on_hold_order = excluded.is_on_hold_order,
        rts_sla_time = excluded.rts_sla_time,
        -- Never stored again once the purge date has passed (Q14); a version without the field
        -- keeps the note already held.
        buyer_message = case
          when t.buyer_message_purge_after is not null and t.buyer_message_purge_after <= ${now.toISOString()}::timestamptz then null
          else coalesce(excluded.buyer_message, t.buyer_message)
        end,
        -- Set once, at the first terminal report.
        buyer_message_purge_after = coalesce(t.buyer_message_purge_after, excluded.buyer_message_purge_after),
        -- Leaving COMPLETED/CANCELLED again should never happen: flagged, never un-purged (§6).
        review_flags = case
          when t.status in (${terminal}) and excluded.status not in (${terminal}) and not ('tiktok_left_terminal' = any(t.review_flags))
            then array_append(t.review_flags, 'tiktok_left_terminal')
          else t.review_flags
        end,
        updated_at = now()
      where t.latest_update_time < excluded.latest_update_time
      returning (xmax = 0) as created
    `);
    const projection: TikTokProjectionOutcome = projected.length === 0 ? "unchanged" : projected[0]!.created ? "created" : "advanced";

    if (isConflict) {
      await tx.execute(sql`
        update tiktok_orders set review_flags = array_append(review_flags, 'tiktok_snapshot_conflict'), updated_at = now()
        where tiktok_order_id = ${order.tiktokOrderId} and not ('tiktok_snapshot_conflict' = any(review_flags))
      `);
    }
    return { snapshot: isConflict ? "conflict" : "inserted", projection, autoMapped };
  });
}

/** The SKU an Ammari variant would have: trimmed and uppercase (Daftar SKU's spelling). */
export function normalizeTikTokSellerSku(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sku = value.trim().toUpperCase();
  return sku.length > 0 && sku.length <= 128 ? sku : null;
}

interface SnapshotLine {
  skuId: string;
  productId: string | null;
  sellerSku: string | null;
}

function textField(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 && value.length <= 512 ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

/** The line items of an allowlisted order payload that carry a SKU id. */
export function tiktokSnapshotLines(payload: AllowlistedObject): SnapshotLine[] {
  const items = payload.line_items;
  if (!Array.isArray(items)) return [];
  const lines: SnapshotLine[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const skuId = textField(item.sku_id);
    if (!skuId || skuId.length > 128) continue;
    lines.push({ skuId, productId: textField(item.product_id), sellerSku: textField(item.seller_sku) });
  }
  return lines;
}

/** Auto-maps every line whose seller SKU, trimmed and uppercased, is exactly an active Ammari SKU
 * (variant and product active) and whose TikTok SKU has no mapping row yet. A near miss is never
 * mapped. An existing row, active or not, is never touched (ON CONFLICT DO NOTHING): a person's
 * mapping or removal wins. Each new row is audited (`tiktok_sku_auto_map`, no actor). */
export async function autoMapTikTokSkus(tx: Tx, payload: AllowlistedObject): Promise<string[]> {
  const mapped: string[] = [];
  const seen = new Set<string>();
  for (const line of tiktokSnapshotLines(payload)) {
    if (seen.has(line.skuId)) continue;
    seen.add(line.skuId);
    const normalized = normalizeTikTokSellerSku(line.sellerSku);
    if (!normalized) continue;
    // The same lock a person's map/remove takes (sku-mappings.ts), so its audit "before" is exact.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tiktok-sku:${line.skuId}`}))`);
    const rows = await tx.execute<{ tiktok_sku_id: string; variant_sku: string }>(sql`
      insert into tiktok_sku_mappings (tiktok_sku_id, tiktok_product_id, seller_sku, variant_sku, source)
      select ${line.skuId}, ${line.productId}, ${line.sellerSku}, pv.sku, 'auto_seller_sku'
      from product_variants pv join products p on p.id = pv.product_id
      where pv.sku = ${normalized} and pv.is_active and p.is_active
      on conflict (tiktok_sku_id) do nothing
      returning tiktok_sku_id, variant_sku
    `);
    const row = rows[0];
    if (!row) continue;
    mapped.push(row.tiktok_sku_id);
    await writeAuditLog(tx, {
      actorStaffUserId: null,
      action: "tiktok_sku_auto_map",
      entityType: ENTITY_SKU_MAPPING,
      entityId: row.tiktok_sku_id,
      after: { tiktokSkuId: row.tiktok_sku_id, tiktokProductId: line.productId, sellerSku: line.sellerSku, variantSku: row.variant_sku, source: "auto_seller_sku" },
    });
  }
  return mapped;
}
