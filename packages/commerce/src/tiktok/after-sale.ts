import "server-only";
import { sql } from "drizzle-orm";
import type { OrderAttentionFlag, OrderStatus, TikTokAfterSaleKind, TikTokAfterSaleReviewReason, TikTokAfterSaleState, TikTokSnapshotSource } from "@ammari/db/schema";
import type { AllowlistedObject, TikTokAfterSaleProjection } from "@ammari/tiktok-shop";
import { writeAuditLog, type Database, type Tx } from "../db";
import { ActionError, isPostgresErrorCode } from "../errors";
import { transitionOrderStatus } from "../orders/lifecycle";
import { decideTikTokAfterSale, tiktokAfterSaleFlags, tiktokAfterSaleResponseDue } from "./after-sale-rules";
import { flagsExpression } from "./apply";

// TikTok cancellations and returns (docs/plans/tiktok-shop-integration.md §4.5, T6): the stored
// requests and what they do to the admin order. The decision is pure (after-sale-rules.ts); this is
// the store and the one transaction that carries a decision out.
//
// Every write for one TikTok order runs under `pg_advisory_xact_lock(hashtext('tiktok-order:' || id))`,
// the key the order store and T5's apply take, so a webhook drain, the poll and the re-check of the
// same order (its order versions and its requests) run one after the other. Everything is re-read
// under that lock; the admin order is locked FOR UPDATE. Nothing here changes an order's status or
// stock: the only status move is "Retur diterima" (`receiveMarketplaceReturn`), a person's action
// that goes through transitionOrderStatus, which writes the exact-negation return movements (Q11,
// Q18). Refund-only money is one `marketplace_refunds` row, `INSERT ... ON CONFLICT DO NOTHING`
// (unique per channel refund id), so a replay or a race writes it once (Q10).

const ROW_LOCK_TIMEOUT = "10s";
/** Review reasons that come from the admin order's state, not from TikTok's request. */
const ADMIN_DEPENDENT_REASONS: ReadonlySet<TikTokAfterSaleReviewReason> = new Set(["before_shipping", "after_return", "lines_unknown"]);
const COMPLETE_STATUS = "RETURN_OR_REFUND_REQUEST_COMPLETE";

export type IngestTikTokAfterSaleResult = {
  /** `order_mismatch`: TikTok named another order for a request already stored under one; the
   * projection is never re-pointed (the snapshot is kept, the caller holds its cursor). */
  snapshot: "inserted" | "replay" | "conflict" | "order_mismatch";
  projection: "created" | "advanced" | "unchanged";
};

/** Stores one version of a return or cancellation: the snapshot (kind `return` / `cancellation`,
 * keyed by the TikTok order id, `ON CONFLICT DO NOTHING`) and the forward-only projection with its
 * response deadline. Read side only: no order write. Runs whatever the kill switch says. */
export async function ingestTikTokAfterSale(db: Database, record: TikTokAfterSaleProjection, source: TikTokSnapshotSource, now: Date = new Date()): Promise<IngestTikTokAfterSaleResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tiktok-order:${record.tiktokOrderId}`}))`);
    const updateTime = record.updateTime.toISOString();
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into tiktok_order_snapshots (tiktok_order_id, update_time, content_sha256, payload, source, kind, fetched_at)
      values (${record.tiktokOrderId}, ${updateTime}::timestamptz, ${record.contentSha256}, ${JSON.stringify(record.payload)}::jsonb, ${source}, ${record.kind}, ${now.toISOString()}::timestamptz)
      on conflict (tiktok_order_id, update_time, content_sha256) do nothing
      returning id
    `);
    const snapshotId = inserted[0]?.id;
    if (!snapshotId) return { snapshot: "replay", projection: "unchanged" };

    const due = tiktokAfterSaleResponseDue(record);
    const completedAt = record.kind === "return" && record.status === COMPLETE_STATUS ? updateTime : null;
    const projected = await tx.execute<{ created: boolean }>(sql`
      insert into tiktok_returns as r (kind, request_id, tiktok_order_id, status, request_type, create_time, latest_update_time, latest_snapshot_id, response_due_at, completed_at, first_seen_at)
      values (${record.kind}, ${record.requestId}, ${record.tiktokOrderId}, ${record.status}, ${record.requestType}, ${record.createTime?.toISOString() ?? null}::timestamptz,
              ${updateTime}::timestamptz, ${snapshotId}::uuid, ${due?.toISOString() ?? null}::timestamptz, ${completedAt}::timestamptz, ${now.toISOString()}::timestamptz)
      on conflict (kind, request_id) do update set
        status = excluded.status,
        request_type = excluded.request_type,
        create_time = coalesce(excluded.create_time, r.create_time),
        latest_update_time = excluded.latest_update_time,
        latest_snapshot_id = excluded.latest_snapshot_id,
        response_due_at = excluded.response_due_at,
        -- Written once: the first COMPLETE version dates the return (marketplace_returned_at).
        completed_at = coalesce(r.completed_at, excluded.completed_at),
        updated_at = now()
      where r.latest_update_time < excluded.latest_update_time and r.tiktok_order_id = excluded.tiktok_order_id
      returning (xmax = 0) as created
    `);
    if (projected.length > 0) return { snapshot: "inserted", projection: projected[0]!.created ? "created" : "advanced" };
    const [existing] = await tx.execute<{ tiktok_order_id: string; same: boolean }>(sql`
      select tiktok_order_id, latest_update_time = ${updateTime}::timestamptz as same from tiktok_returns where kind = ${record.kind} and request_id = ${record.requestId}
    `);
    if (existing && existing.tiktok_order_id !== record.tiktokOrderId) return { snapshot: "order_mismatch", projection: "unchanged" };
    // An older COMPLETE version arriving after a newer one still dates the return: the earliest
    // COMPLETE version wins (written once, never moved later).
    if (completedAt) {
      await tx.execute(sql`
        update tiktok_returns set completed_at = least(coalesce(completed_at, ${completedAt}::timestamptz), ${completedAt}::timestamptz), updated_at = now()
        where kind = ${record.kind} and request_id = ${record.requestId} and (completed_at is null or completed_at > ${completedAt}::timestamptz)
      `);
    }
    // Not advanced: an older version arriving late, or the same `update_time` with other content
    // (kept as its own snapshot, never silently chosen; the first one stays applied).
    return { snapshot: existing?.same ? "conflict" : "inserted", projection: "unchanged" };
  });
}

export type ApplyTikTokAfterSaleResult =
  | { kind: "applied"; state: TikTokAfterSaleState; orderId: string | null; refundRecorded: boolean; changed: boolean }
  | { kind: "unchanged"; state: TikTokAfterSaleState }
  | { kind: "not_found" }
  | { kind: "busy"; code: string };

export interface ApplyTikTokAfterSaleOptions {
  now?: Date;
  source: TikTokSnapshotSource | "recheck";
}

interface LockedRequest {
  tiktok_order_id: string;
  status: string;
  request_type: string | null;
  latest_update_time: Date;
  completed_at: Date | null;
  response_due_at: Date | null;
  order_id: string | null;
  state: TikTokAfterSaleState | null;
  review_reason: TikTokAfterSaleReviewReason | null;
  applied_update_time: Date | null;
  payload: AllowlistedObject;
}

const toDate = (value: unknown): Date | null => (value === null || value === undefined ? null : new Date(value as string));

function orderLineIds(payload: AllowlistedObject | null): string[] | null {
  if (!payload || !Array.isArray(payload.line_items)) return null;
  const ids: string[] = [];
  for (const item of payload.line_items) {
    if (typeof item !== "object" || item === null || Array.isArray(item) || typeof item.id !== "string" || item.id === "") return null;
    ids.push(item.id);
  }
  return ids;
}

function sameFlags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((flag, index) => flag === b[index]);
}

async function commit(tx: Tx, kind: TikTokAfterSaleKind, requestId: string, options: Required<ApplyTikTokAfterSaleOptions>): Promise<ApplyTikTokAfterSaleResult> {
  const { now, source } = options;
  await tx.execute(sql`select set_config('lock_timeout', ${ROW_LOCK_TIMEOUT}, true)`);
  // The order id never changes for a request (the store refuses another), so reading it before the
  // lock only picks the lock key; everything else is re-read under it.
  const [key] = await tx.execute<{ tiktok_order_id: string }>(sql`select tiktok_order_id from tiktok_returns where kind = ${kind} and request_id = ${requestId}`);
  if (!key) return { kind: "not_found" };
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tiktok-order:${key.tiktok_order_id}`}))`);
  const [raw] = await tx.execute<Record<string, unknown>>(sql`
    select r.tiktok_order_id, r.status, r.request_type, r.latest_update_time, r.completed_at, r.response_due_at, r.order_id, r.state,
           r.review_reason, r.applied_update_time, s.payload
    from tiktok_returns r join tiktok_order_snapshots s on s.id = r.latest_snapshot_id
    where r.kind = ${kind} and r.request_id = ${requestId}
    for update of r
  `);
  if (!raw) return { kind: "not_found" };
  const request: LockedRequest = {
    tiktok_order_id: String(raw.tiktok_order_id),
    status: String(raw.status),
    request_type: (raw.request_type as string | null) ?? null,
    latest_update_time: toDate(raw.latest_update_time)!,
    completed_at: toDate(raw.completed_at),
    response_due_at: toDate(raw.response_due_at),
    order_id: (raw.order_id as string | null) ?? null,
    state: (raw.state as TikTokAfterSaleState | null) ?? null,
    review_reason: (raw.review_reason as TikTokAfterSaleReviewReason | null) ?? null,
    applied_update_time: toDate(raw.applied_update_time),
    payload: raw.payload as AllowlistedObject,
  };

  const [order] = await tx.execute<{ status: string; order_id: string | null; apply_state: string | null; payload: AllowlistedObject | null }>(sql`
    select t.status, t.order_id, t.apply_state, s.payload
    from tiktok_orders t join tiktok_order_snapshots s on s.id = t.latest_snapshot_id
    where t.tiktok_order_id = ${request.tiktok_order_id}
  `);
  const adminId = order?.order_id ?? null;
  const [admin] = adminId
    ? await tx.execute<{ id: string; status: OrderStatus; total_amount: number | string; needs_attention: OrderAttentionFlag[]; marketplace_returned_at: string | Date | null }>(sql`
        select id, status, total_amount, needs_attention, marketplace_returned_at from orders where id = ${adminId}::uuid for update
      `)
    : [];

  // A decision that depended on the admin order as it was then is made again once the order moved:
  // a request parked because admin had not shipped yet (or had already returned it, or its lines were
  // unknown), and a request closed because the order was skipped that is in admin now.
  const revisit =
    (request.state === "review" && request.review_reason !== null && ADMIN_DEPENDENT_REASONS.has(request.review_reason)) || (request.state === "closed" && request.order_id === null && admin !== undefined);
  const sameVersion = !revisit && request.state !== null && request.state !== "waiting_order" && request.applied_update_time?.getTime() === request.latest_update_time.getTime();
  const decided = sameVersion
    ? null
    : decideTikTokAfterSale({
        kind,
        status: request.status,
        requestType: request.request_type,
        updateTime: request.latest_update_time,
        completedAt: request.completed_at,
        payload: request.payload,
        previousState: request.state,
        orderLineIds: orderLineIds(order?.payload ?? null),
        admin: admin ? { status: admin.status, totalAmount: Number(admin.total_amount) } : null,
        orderSkipped: !admin && (order?.apply_state === "skipped_unpaid" || order?.apply_state === "skipped_undone"),
      });
  // Refund-only money is checked per order, not per request: every refund of the order together may
  // never exceed its total, and a completed refund whose amount TikTok later reports differently is
  // never rewritten (append-only, §3.4). Both go to a person.
  if (decided?.refundAmount && admin) {
    const [refunds] = await tx.execute<{ others: number | string; mine: number | string | null }>(sql`
      select coalesce(sum(amount) filter (where channel_refund_id <> ${requestId}), 0) as others,
             max(amount) filter (where channel_refund_id = ${requestId}) as mine
      from marketplace_refunds where order_id = ${admin.id}::uuid and channel_id = 'tiktok'
    `);
    const mine = refunds?.mine === null || refunds?.mine === undefined ? null : Number(refunds.mine);
    if (mine !== null && mine !== decided.refundAmount) Object.assign(decided, { state: "review", reviewReason: "money_format", refundAmount: null });
    else if (Number(refunds?.others ?? 0) + decided.refundAmount > Number(admin.total_amount)) Object.assign(decided, { state: "review", reviewReason: "refund_over_total", refundAmount: null });
  }
  const state = decided?.state ?? request.state!;

  if (decided) {
    // A waiting request is not "applied": the re-check picks it up again once the order is in admin.
    const applied = decided.state === "waiting_order" ? null : request.latest_update_time.toISOString();
    await tx.execute(sql`
      update tiktok_returns set state = ${decided.state}, review_reason = ${decided.reviewReason}, order_id = ${admin?.id ?? null}::uuid,
        applied_update_time = ${applied}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
      where kind = ${kind} and request_id = ${requestId}
    `);
  }
  const stateChanged = decided !== null && (decided.state !== request.state || decided.reviewReason !== request.review_reason);

  if (!admin) {
    if (stateChanged) {
      await writeAuditLog(tx, {
        actorStaffUserId: null,
        action: "tiktok_return_update",
        entityType: "tiktok_order",
        entityId: request.tiktok_order_id,
        before: { state: request.state },
        after: { source, kind, requestId, tiktokStatus: request.status, state, reviewReason: decided!.reviewReason },
      });
    }
    return decided ? { kind: "applied", state, orderId: null, refundRecorded: false, changed: stateChanged } : { kind: "unchanged", state };
  }

  let refundRecorded = false;
  if (decided?.refundAmount) {
    // Refund-only (Q10): money only. Status, stock and HPP stay as they are.
    const refundedAt = (request.completed_at ?? request.latest_update_time).toISOString();
    const rows = await tx.execute<{ id: string }>(sql`
      insert into marketplace_refunds (order_id, channel_id, channel_refund_id, kind, amount, refunded_at)
      values (${admin.id}::uuid, 'tiktok', ${requestId}, 'refund_only', ${decided.refundAmount}, ${refundedAt}::timestamptz)
      on conflict (channel_id, channel_refund_id) do nothing
      returning id
    `);
    refundRecorded = rows.length > 0;
    if (refundRecorded) {
      await writeAuditLog(tx, {
        actorStaffUserId: null,
        action: "tiktok_refund_record",
        entityType: "order",
        entityId: admin.id,
        after: { source, tiktokOrderId: request.tiktok_order_id, requestId, kind: "refund_only", amount: decided.refundAmount, refundedAt },
      });
    }
  }

  const rows = await tx.execute<{ kind: TikTokAfterSaleKind; state: TikTokAfterSaleState; response_due_at: string | Date | null }>(sql`
    select kind, state, response_due_at from tiktok_returns
    where tiktok_order_id = ${request.tiktok_order_id} and state is not null and state <> 'waiting_order'
  `);
  const flags = tiktokAfterSaleFlags({
    rows: rows.map((row) => ({ kind: row.kind, state: row.state, responseDueAt: toDate(row.response_due_at) })),
    changed: decided ? { kind, from: request.state === "waiting_order" ? null : request.state, to: decided.state } : null,
    adminStatus: admin.status,
    tiktokStatus: order?.status ?? null,
    now,
  });
  const returnedAt = decided?.returnedAt && admin.marketplace_returned_at === null ? decided.returnedAt.toISOString() : null;
  const [after] = await tx.execute<{ needs_attention: OrderAttentionFlag[] }>(sql`
    update orders set needs_attention = ${flagsExpression(flags.add, flags.remove)},
      marketplace_returned_at = coalesce(marketplace_returned_at, ${returnedAt}::timestamptz)
    where id = ${admin.id}::uuid
    returning needs_attention
  `);
  const flagsChanged = !sameFlags(admin.needs_attention, after!.needs_attention);
  const changed = stateChanged || flagsChanged || returnedAt !== null || refundRecorded;
  if (stateChanged || flagsChanged || returnedAt !== null) {
    await writeAuditLog(tx, {
      actorStaffUserId: null,
      action: "tiktok_return_update",
      entityType: "order",
      entityId: admin.id,
      before: { needsAttention: admin.needs_attention, state: request.state },
      after: {
        source,
        tiktokOrderId: request.tiktok_order_id,
        kind,
        requestId,
        tiktokStatus: request.status,
        state,
        reviewReason: decided?.reviewReason ?? request.review_reason,
        needsAttention: after!.needs_attention,
        ...(request.response_due_at ? { responseDueAt: request.response_due_at.toISOString() } : {}),
        ...(returnedAt ? { marketplaceReturnedAt: returnedAt } : {}),
        ...(decided ? {} : { reason: "response_deadline" }),
      },
    });
  }
  return decided ? { kind: "applied", state, orderId: admin.id, refundRecorded, changed } : changed ? { kind: "applied", state, orderId: admin.id, refundRecorded, changed } : { kind: "unchanged", state };
}

/** Applies the latest stored version of one request. Idempotent: the same version applied again
 * writes nothing beyond the response-deadline flag (a deadline passing fires no webhook). The
 * caller (sync.ts) checks the kill switch first. */
export async function applyTikTokAfterSale(db: Database, kind: TikTokAfterSaleKind, requestId: string, options: ApplyTikTokAfterSaleOptions): Promise<ApplyTikTokAfterSaleResult> {
  const resolved = { now: options.now ?? new Date(), source: options.source };
  try {
    return await db.transaction((tx) => commit(tx, kind, requestId, resolved));
  } catch (error) {
    if (isPostgresErrorCode(error, "55P03")) return { kind: "busy", code: "lock_timeout" };
    if (isPostgresErrorCode(error, "40P01")) return { kind: "busy", code: "deadlock" };
    throw error;
  }
}

export const TIKTOK_AFTER_SALE_RECHECK_LIMIT = 200;
/** A request waiting for its order is re-checked at most this often. */
export const TIKTOK_AFTER_SALE_WAIT_RECHECK_MS = 15 * 60_000;

/** The requests the cron re-checks each run (no TikTok call): never applied, a newer version than
 * the one applied, waiting for their order, and those whose order still carries the response flag
 * while no request of it is due any more (the deadline passed). */
export async function listTikTokAfterSalesToApply(db: Database, now: Date = new Date(), limit = TIKTOK_AFTER_SALE_RECHECK_LIMIT): Promise<{ items: { kind: TikTokAfterSaleKind; requestId: string }[]; truncated: boolean }> {
  const waitBefore = new Date(now.getTime() - TIKTOK_AFTER_SALE_WAIT_RECHECK_MS).toISOString();
  const at = now.toISOString();
  const rows = await db.execute<{ kind: TikTokAfterSaleKind; request_id: string }>(sql`
    select r.kind, r.request_id from tiktok_returns r
    left join orders o on o.id = r.order_id
    where r.state is null
       or (r.state = 'waiting_order' and r.updated_at <= ${waitBefore}::timestamptz)
       or (r.state <> 'waiting_order' and (r.applied_update_time is null or r.applied_update_time < r.latest_update_time))
       or (r.response_due_at is not null and r.response_due_at <= ${at}::timestamptz and 'tiktok_return_response_due' = any(o.needs_attention)
           and not exists (select 1 from tiktok_returns d where d.tiktok_order_id = r.tiktok_order_id and d.response_due_at > ${at}::timestamptz))
       -- Decisions that depended on the admin order (after-sale.ts ADMIN_DEPENDENT_REASONS), and
       -- requests closed because their order was skipped, once that order is in admin.
       or (r.state = 'review' and r.review_reason in ('before_shipping', 'after_return', 'lines_unknown') and r.updated_at <= ${waitBefore}::timestamptz)
       or (r.state = 'closed' and r.order_id is null and exists (select 1 from tiktok_orders t where t.tiktok_order_id = r.tiktok_order_id and t.order_id is not null))
    -- New work first; waiting and parked requests after it, least recently checked first, so a pile
    -- of requests whose order never comes rotates instead of starving the rest.
    order by (r.state is null or (r.state not in ('waiting_order', 'review', 'closed') )) desc, r.updated_at, r.kind, r.request_id
    limit ${limit + 1}
  `);
  return { items: rows.slice(0, limit).map((row) => ({ kind: row.kind, requestId: row.request_id })), truncated: rows.length > limit };
}

export const RETURN_RECEIVED_MESSAGES = {
  notFound: "Pesanan tidak ditemukan.",
  notInTransit: "Retur diterima hanya untuk paket yang tercatat sedang kembali ke toko.",
} as const;

/** "Retur diterima" (plan §4.5, Q11, Q18): staff confirm the parcel is physically back. Offered only
 * while `marketplace_return_in_transit` is set; runs `transitionOrderStatus(→ returned)`, which writes
 * the exact-negation return movements and clears the return flags, in one transaction under the
 * order's row lock. The caller checks `orders.manage` on the server. */
export async function receiveMarketplaceReturn(db: Database, orderId: string, staffUserId: string): Promise<{ orderNo: string }> {
  return db.transaction(async (tx) => {
    const [order] = await tx.execute<{ order_no: string; status: OrderStatus; needs_attention: OrderAttentionFlag[]; marketplace_returned_at: string | Date | null }>(sql`
      select order_no, status, needs_attention, marketplace_returned_at from orders where id = ${orderId}::uuid for update
    `);
    if (!order) throw new ActionError(RETURN_RECEIVED_MESSAGES.notFound);
    if (!order.needs_attention.includes("marketplace_return_in_transit")) throw new ActionError(RETURN_RECEIVED_MESSAGES.notInTransit);
    await transitionOrderStatus(orderId, "returned", staffUserId, tx);
    await writeAuditLog(tx, {
      actorStaffUserId: staffUserId,
      action: "marketplace_return_received",
      entityType: "order",
      entityId: orderId,
      before: { status: order.status, needsAttention: order.needs_attention },
      after: { status: "returned", marketplaceReturnedAt: order.marketplace_returned_at ? new Date(order.marketplace_returned_at).toISOString() : null },
    });
    return { orderNo: order.order_no };
  });
}
