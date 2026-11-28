import "server-only";
import { sql } from "drizzle-orm";
import type { TikTokAfterSaleKind, TikTokAfterSaleReviewReason, TikTokAfterSaleState } from "@ammari/db/schema";
import { defaultDb, type Database } from "@/lib/db";

// Retur dan pembatalan TikTok (docs/plans/tiktok-shop-integration.md §4.5, T6), read side for admin:
//   - requests waiting for the seller's answer in Seller Center, soonest deadline first (Q15: we never
//     answer through the API; TikTok approves automatically after 48 h, §0);
//   - parcels on their way back (`marketplace_return_in_transit`), oldest first, with "Retur diterima";
//   - requests the rules could not classify, or partial returns, for a person.
// Deadlines are stored at ingest, so the first list works while applying is still off (dry run).

export const TIKTOK_RETURN_LIST_LIMIT = 200;

export interface TikTokRequestRow {
  kind: TikTokAfterSaleKind;
  requestId: string;
  tiktokOrderId: string;
  status: string;
  requestType: string | null;
  responseDueAt: Date | null;
  state: TikTokAfterSaleState | null;
  reviewReason: TikTokAfterSaleReviewReason | null;
  orderId: string | null;
  orderNo: string | null;
  updatedAt: Date;
}

export interface ReturnInTransitRow {
  orderId: string;
  orderNo: string;
  channelOrderNo: string | null;
  status: string;
  /** TikTok's return or cancel time, else when the order shipped: the age the list sorts by. */
  since: Date | null;
}

export interface TikTokReturnsOverview {
  responseDue: TikTokRequestRow[];
  inTransit: ReturnInTransitRow[];
  needsPerson: TikTokRequestRow[];
}

type RequestSqlRow = {
  kind: TikTokAfterSaleKind;
  request_id: string;
  tiktok_order_id: string;
  status: string;
  request_type: string | null;
  response_due_at: string | Date | null;
  state: TikTokAfterSaleState | null;
  review_reason: TikTokAfterSaleReviewReason | null;
  order_id: string | null;
  order_no: string | null;
  updated_at: string | Date;
};

function toRequest(row: RequestSqlRow): TikTokRequestRow {
  return {
    kind: row.kind,
    requestId: row.request_id,
    tiktokOrderId: row.tiktok_order_id,
    status: row.status,
    requestType: row.request_type,
    responseDueAt: row.response_due_at ? new Date(row.response_due_at) : null,
    state: row.state,
    reviewReason: row.review_reason,
    orderId: row.order_id,
    orderNo: row.order_no,
    updatedAt: new Date(row.updated_at),
  };
}

// The admin order: the one the request was applied to, else the one the TikTok order was applied to.
const requestColumns = sql`r.kind, r.request_id, r.tiktok_order_id, r.status, r.request_type, r.response_due_at, r.state, r.review_reason,
  o.id as order_id, o.order_no, r.updated_at`;
const requestFrom = sql`from tiktok_returns r
  left join tiktok_orders t on t.tiktok_order_id = r.tiktok_order_id
  left join orders o on o.id = coalesce(r.order_id, t.order_id)`;

/** States after which nothing waits for the seller (the stored deadline is cleared then, too). */
const SETTLED = sql`('completed_goods', 'completed_refund', 'cancel_completed', 'closed')`;

export async function getTikTokReturnsOverview(now: Date = new Date(), db: Database = defaultDb): Promise<TikTokReturnsOverview> {
  const [due, inTransit, person] = await Promise.all([
    db.execute<RequestSqlRow>(sql`
      select ${requestColumns} ${requestFrom}
      where r.response_due_at is not null and r.response_due_at > ${now.toISOString()}::timestamptz
        and (r.state is null or r.state not in ${SETTLED})
      order by r.response_due_at, r.kind, r.request_id
      limit ${TIKTOK_RETURN_LIST_LIMIT}
    `),
    db.execute<{ id: string; order_no: string; channel_order_no: string | null; status: string; since: string | Date | null }>(sql`
      select o.id, o.order_no, o.channel_order_no, o.status, coalesce(o.marketplace_returned_at, o.marketplace_shipped_at, o.shipped_at) as since
      from orders o
      -- TikTok only (this page); cardinality() lets the planner use orders_needs_attention_idx.
      where o.channel_id = 'tiktok' and cardinality(o.needs_attention) > 0 and 'marketplace_return_in_transit' = any(o.needs_attention)
      order by since asc nulls first, o.order_no
      limit ${TIKTOK_RETURN_LIST_LIMIT}
    `),
    db.execute<RequestSqlRow>(sql`
      select ${requestColumns} ${requestFrom}
      where r.state in ('review', 'partial')
      order by r.updated_at desc, r.kind, r.request_id
      limit ${TIKTOK_RETURN_LIST_LIMIT}
    `),
  ]);
  return {
    responseDue: due.map(toRequest),
    inTransit: inTransit.map((row) => ({ orderId: row.id, orderNo: row.order_no, channelOrderNo: row.channel_order_no, status: row.status, since: row.since ? new Date(row.since) : null })),
    needsPerson: person.map(toRequest),
  };
}

/** How many requests wait for an answer in Seller Center (the home page's Perlu dicek block). */
export async function countTikTokResponsesDue(now: Date = new Date(), db: Database = defaultDb): Promise<number> {
  const [row] = await db.execute<{ total: number }>(sql`
    select count(*)::int as total from tiktok_returns r
    where r.response_due_at is not null and r.response_due_at > ${now.toISOString()}::timestamptz and (r.state is null or r.state not in ${SETTLED})
  `);
  return row?.total ?? 0;
}

/** The requests of one admin order (the order page's Marketplace block). */
export async function listTikTokRequestsForOrder(orderId: string, db: Database = defaultDb): Promise<TikTokRequestRow[]> {
  const rows = await db.execute<RequestSqlRow>(sql`
    select ${requestColumns} ${requestFrom}
    -- Both arms indexed (tiktok_returns_order_id_idx, tiktok_orders_order_id_key + tiktok_returns_tiktok_order_id_idx).
    where (r.order_id = ${orderId}::uuid or r.tiktok_order_id in (select tiktok_order_id from tiktok_orders where order_id = ${orderId}::uuid))
    order by r.latest_update_time desc, r.kind, r.request_id
    limit 20
  `);
  return rows.map(toRequest);
}
