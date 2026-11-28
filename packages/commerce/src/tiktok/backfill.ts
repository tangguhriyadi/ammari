import "server-only";
import { sql } from "drizzle-orm";
import { TIKTOK_BACKFILL_FLOOR, type OrderAttentionFlag, type OrderStatus, type TikTokApplyState, type TikTokBackfillState, type TikTokHeldReason } from "@ammari/db/schema";
import type { AllowlistedObject } from "@ammari/tiktok-shop";
import { writeAuditLog, type Database } from "../db";
import { decideTikTokOrder, type TikTokAdminOrderState } from "./apply-rules";
import { tiktokBackfillRange } from "./backfill-windows";

// The T9 backfill (docs/plans/tiktok-shop-integration.md T9, §9.6): a one-off history read of TikTok
// orders, returns, cancellations, statements and payouts from 1 Dec 2026 at the earliest, in "enrich"
// mode. The reading itself runs in the cron (sync.ts, `runTikTokBackfill`), slice by slice, after the
// live steps, within the run's time budget, and resumes at the last finished slice.
//
// The order of things is fixed, so the owner always sees the dry run first:
//   1. "Ambil riwayat" (start, integrations.manage, audited): a row in `fetching`;
//   2. the cron reads history. An order the backfill is the first to store is marked with the
//      backfill's id and is NOT applied, even while the T5 kill switch is on (apply.ts);
//   3. once every resource is read: `fetched` (audited, no actor). The preview ("Pratinjau riwayat")
//      shows what applying would do: which hand-typed orders are matched and enriched (linked, dated,
//      moved forward, number corrected), which are created, held or skipped, and which hand-typed
//      TikTok orders TikTok never returned;
//   4. "Terapkan riwayat" (confirm, integrations.manage, audited): the gate lifts and the cron's
//      re-check applies those orders, still only while the kill switch is on.
// Nothing here calls TikTok.

export interface TikTokBackfillView {
  id: string;
  state: TikTokBackfillState;
  fromTime: Date;
  untilTime: Date;
  ordersDoneUntil: Date | null;
  returnsDoneUntil: Date | null;
  cancellationsDoneUntil: Date | null;
  statementsDoneUntil: Date | null;
  paymentsDoneUntil: Date | null;
  ordersSliceSeconds: number;
  requestedAt: Date;
  requestedByName: string | null;
  fetchedAt: Date | null;
  confirmedAt: Date | null;
  confirmedByName: string | null;
  lastRunAt: Date | null;
  lastErrorCode: string | null;
}

type Row = Record<string, unknown>;
const date = (value: unknown): Date | null => (value === null || value === undefined ? null : new Date(value as string));

function toView(row: Row): TikTokBackfillView {
  return {
    id: String(row.id),
    state: row.state as TikTokBackfillState,
    fromTime: date(row.from_time)!,
    untilTime: date(row.until_time)!,
    ordersDoneUntil: date(row.orders_done_until),
    returnsDoneUntil: date(row.returns_done_until),
    cancellationsDoneUntil: date(row.cancellations_done_until),
    statementsDoneUntil: date(row.statements_done_until),
    paymentsDoneUntil: date(row.payments_done_until),
    ordersSliceSeconds: Number(row.orders_slice_seconds),
    requestedAt: date(row.requested_at)!,
    requestedByName: (row.requested_by_name as string | null) ?? null,
    fetchedAt: date(row.fetched_at),
    confirmedAt: date(row.confirmed_at),
    confirmedByName: (row.confirmed_by_name as string | null) ?? null,
    lastRunAt: date(row.last_run_at),
    lastErrorCode: (row.last_error_code as string | null) ?? null,
  };
}

/** The latest backfill (any state), or null when none was ever started. */
export async function getTikTokBackfillView(db: Database): Promise<TikTokBackfillView | null> {
  const [row] = await db.execute<Row>(sql`
    select b.*, r.name as requested_by_name, c.name as confirmed_by_name
    from tiktok_backfills b
    left join staff_users r on r.id = b.requested_by_staff_user_id
    left join staff_users c on c.id = b.confirmed_by_staff_user_id
    order by b.requested_at desc, b.created_at desc
    limit 1
  `);
  return row ? toView(row) : null;
}

/** The backfill the cron is reading, if any. */
export async function loadFetchingTikTokBackfill(db: Database): Promise<TikTokBackfillView | null> {
  const [row] = await db.execute<Row>(sql`select * from tiktok_backfills where state = 'fetching' limit 1`);
  return row ? toView(row) : null;
}

export type StartTikTokBackfillResult = { ok: true; id: string } | { ok: false; reason: "not_connected" | "already_open" | "invalid_date" | "before_floor" | "not_in_past" };

/** "Ambil riwayat": one backfill from `fromDate` (a Jakarta day, ≥ 1 Dec 2026) to now − 2 min. Only
 * while a shop is connected; refused while another backfill is not confirmed yet (one partial unique
 * index, `ON CONFLICT DO NOTHING`, never check-then-write). Audited `tiktok_backfill_start`. */
export async function startTikTokBackfill(db: Database, input: { fromDate: string; staffUserId: string; now?: Date }): Promise<StartTikTokBackfillResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [connection] = await tx.execute<{ id: string }>(sql`select id from tiktok_shop_connections where status = 'active' limit 1 for share`);
    if (!connection) return { ok: false, reason: "not_connected" };
    const range = tiktokBackfillRange(input.fromDate, now);
    if (!range.ok) return { ok: false, reason: range.reason };
    const [inserted] = await tx.execute<{ id: string }>(sql`
      insert into tiktok_backfills (from_time, until_time, requested_by_staff_user_id, requested_at)
      values (${range.from.toISOString()}::timestamptz, ${range.until.toISOString()}::timestamptz, ${input.staffUserId}::uuid, ${now.toISOString()}::timestamptz)
      on conflict ((true)) where state <> 'confirmed' do nothing
      returning id
    `);
    if (!inserted) return { ok: false, reason: "already_open" };
    await writeAuditLog(tx, {
      actorStaffUserId: input.staffUserId,
      action: "tiktok_backfill_start",
      entityType: "tiktok_backfill",
      entityId: inserted.id,
      after: { fromTime: range.from.toISOString(), untilTime: range.until.toISOString(), state: "fetching" },
    });
    return { ok: true, id: inserted.id };
  });
}

export type ConfirmTikTokBackfillResult = { ok: true; changed: true } | { ok: false; reason: "none" | "still_fetching" };

/** "Terapkan riwayat": lifts the gate on the orders a fetched backfill stored. One conditional UPDATE;
 * audited `tiktok_backfill_confirm`. Applying still needs the kill switch on (the sync checks it). */
export async function confirmTikTokBackfill(db: Database, input: { staffUserId: string; now?: Date }): Promise<ConfirmTikTokBackfillResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{ id: string }>(sql`
      update tiktok_backfills set state = 'confirmed', confirmed_at = ${now.toISOString()}::timestamptz, confirmed_by_staff_user_id = ${input.staffUserId}::uuid
      where state = 'fetched'
      returning id
    `);
    if (!row) {
      const [fetching] = await tx.execute<{ id: string }>(sql`select id from tiktok_backfills where state = 'fetching' limit 1`);
      return { ok: false, reason: fetching ? "still_fetching" : "none" };
    }
    const [{ gated } = { gated: 0 }] = await tx.execute<{ gated: number }>(sql`select count(*)::int as gated from tiktok_orders where backfill_id = ${row.id}::uuid and apply_state is null`);
    await writeAuditLog(tx, {
      actorStaffUserId: input.staffUserId,
      action: "tiktok_backfill_confirm",
      entityType: "tiktok_backfill",
      entityId: row.id,
      before: { state: "fetched" },
      after: { state: "confirmed", ordersReleased: Number(gated) },
    });
    return { ok: true, changed: true };
  });
}

export type TikTokBackfillResource = "orders" | "returns" | "cancellations" | "statements" | "payments";

const DONE_COLUMN: Record<TikTokBackfillResource, string> = {
  orders: "orders_done_until",
  returns: "returns_done_until",
  cancellations: "cancellations_done_until",
  statements: "statements_done_until",
  payments: "payments_done_until",
};

/** Forward only, and only while the backfill is still being read. */
export async function advanceTikTokBackfill(db: Database, id: string, resource: TikTokBackfillResource, doneUntil: Date): Promise<void> {
  const column = sql.raw(DONE_COLUMN[resource]);
  await db.execute(sql`
    update tiktok_backfills set ${column} = ${doneUntil.toISOString()}::timestamptz
    where id = ${id}::uuid and state = 'fetching' and (${column} is null or ${column} < ${doneUntil.toISOString()}::timestamptz)
  `);
}

export async function setTikTokBackfillSlice(db: Database, id: string, sliceSeconds: number): Promise<void> {
  await db.execute(sql`update tiktok_backfills set orders_slice_seconds = ${sliceSeconds} where id = ${id}::uuid and state = 'fetching' and orders_slice_seconds <> ${sliceSeconds}`);
}

/** `keepError`: a run that only ran out of budget keeps the previous error code (a stuck slice must
 * not flap between its code and nothing). */
export async function recordTikTokBackfillRun(db: Database, id: string, now: Date, errorCode: string | null, options: { keepError?: boolean } = {}): Promise<void> {
  await db.execute(sql`
    update tiktok_backfills set last_run_at = ${now.toISOString()}::timestamptz,
      last_error_code = ${options.keepError ? sql`last_error_code` : sql`${errorCode ? errorCode.slice(0, 64) : null}`}
    where id = ${id}::uuid
  `);
}

/** `fetching → fetched` once every resource is read up to `until_time` (conditional, audited once). */
export async function markTikTokBackfillFetched(db: Database, id: string, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{ id: string; gated: number }>(sql`
      update tiktok_backfills b set state = 'fetched', fetched_at = ${now.toISOString()}::timestamptz
      where id = ${id}::uuid and state = 'fetching'
        and orders_done_until >= until_time and returns_done_until >= until_time and cancellations_done_until >= until_time
        and statements_done_until >= until_time and payments_done_until >= until_time
      returning id, (select count(*)::int from tiktok_orders t where t.backfill_id = b.id) as gated
    `);
    if (!row) return false;
    await writeAuditLog(tx, { actorStaffUserId: null, action: "tiktok_backfill_fetched", entityType: "tiktok_backfill", entityId: id, before: { state: "fetching" }, after: { state: "fetched", ordersStored: Number(row.gated) } });
    return true;
  });
}

// ---- Matching hand-typed orders ---------------------------------------------------------------

/** What hand entry may add around a TikTok order number: spaces, `#`, `.` and `-`. The same set as
 * the SQL below (`TIKTOK_ORDER_NO_SEPARATORS_SQL`). */
export function normalizeTikTokOrderNo(value: string): string {
  return value.replace(/[\s#.-]/g, "");
}

/** A POSIX class for `regexp_replace(channel_order_no, …, '', 'g')`. */
export const TIKTOK_ORDER_NO_SEPARATORS_SQL = "[[:space:]#.-]";

// ---- Preview --------------------------------------------------------------------------------

export const TIKTOK_BACKFILL_PREVIEW_LIMIT = 200;

export interface TikTokBackfillEnrichRow {
  tiktokOrderId: string;
  tiktokStatus: string;
  orderId: string;
  orderNo: string;
  /** As typed by hand; differs from the TikTok number when it carried separators (it is corrected). */
  typedNumber: string;
  statusFrom: OrderStatus;
  statusTo: OrderStatus;
  fillsShippedAt: boolean;
  fillsCompletedAt: boolean;
}

export interface TikTokBackfillCreateRow {
  tiktokOrderId: string;
  tiktokStatus: string;
  orderDate: Date;
  totalAmount: number;
  pieces: number;
  statusTo: OrderStatus;
  /** Shipped before the books start (1 Dec 2026): its stock leaves now, but its sale is never journaled
   * (before the cut-over). Shown so the owner decides before "Terapkan riwayat". */
  shippedBeforeBooks: boolean;
}

export interface TikTokBackfillPreview {
  backfill: TikTokBackfillView;
  counts: { enrich: number; create: number; held: number; skip: number; notInTikTok: number };
  enrich: TikTokBackfillEnrichRow[];
  create: TikTokBackfillCreateRow[];
  held: { tiktokOrderId: string; tiktokStatus: string; reason: TikTokHeldReason; detail: string | null }[];
  skip: { tiktokOrderId: string; tiktokStatus: string; reason: "unpaid" | "cancelled" }[];
  /** Hand-typed TikTok orders dated inside the range whose number TikTok never returned (a typo, an
   * order from another shop, or one TikTok no longer lists). */
  notInTikTok: { orderId: string; orderNo: string; channelOrderNo: string; orderDate: Date; status: OrderStatus }[];
  /** After "Terapkan riwayat": what applying did so far, per apply state (null = not applied yet). */
  applied: { state: TikTokApplyState | null; count: number }[];
}

interface AdminCandidate extends TikTokAdminOrderState {
  id: string;
  orderNo: string;
  channelOrderNo: string;
}

/** What applying the backfill would do, computed at read time with the same pure rules as the commit
 * (decideTikTokOrder). Read only. Stock is not checked here: a create the ledger refuses is held
 * `short_stock` when applied. Null when no backfill was ever started. */
export async function getTikTokBackfillPreview(db: Database, now: Date = new Date()): Promise<TikTokBackfillPreview | null> {
  const backfill = await getTikTokBackfillView(db);
  if (!backfill) return null;
  const orders = await db.execute<Row>(sql`
    select t.tiktok_order_id, t.status, t.paid_time, t.collection_time, t.cancel_time, t.is_on_hold_order, t.latest_update_time, s.payload
    from tiktok_orders t join tiktok_order_snapshots s on s.id = t.latest_snapshot_id
    where t.backfill_id = ${backfill.id}::uuid and t.apply_state is null
    order by t.latest_update_time, t.tiktok_order_id
  `);
  const ids = orders.map((row) => String(row.tiktok_order_id));
  const separators = TIKTOK_ORDER_NO_SEPARATORS_SQL;
  const admins =
    ids.length === 0
      ? []
      : await db.execute<Row>(sql`
          select o.id, o.order_no, o.channel_order_no, o.status, o.needs_attention, o.marketplace_shipped_at, o.marketplace_completed_at, o.marketplace_returned_at,
                 regexp_replace(o.channel_order_no, ${separators}, '', 'g') as normalized,
                 coalesce((select json_agg(json_build_object('sku', i.sku, 'qty', i.qty)) from order_items i where i.order_id = o.id), '[]'::json) as lines
          from orders o
          where o.channel_id = 'tiktok' and regexp_replace(o.channel_order_no, ${separators}, '', 'g') = any(${sql.param(ids)}::text[])
            -- As the commit: an admin order already linked to a TikTok order is not a candidate.
            and not exists (select 1 from tiktok_orders t where t.order_id = o.id)
        `);
  const byNumber = new Map<string, AdminCandidate[]>();
  for (const row of admins) {
    const candidate: AdminCandidate = {
      id: String(row.id),
      orderNo: String(row.order_no),
      channelOrderNo: String(row.channel_order_no),
      status: row.status as OrderStatus,
      needsAttention: (row.needs_attention as OrderAttentionFlag[]) ?? [],
      marketplaceShippedAt: date(row.marketplace_shipped_at),
      marketplaceCompletedAt: date(row.marketplace_completed_at),
      marketplaceReturnedAt: date(row.marketplace_returned_at),
      lines: (row.lines as { sku: string; qty: number }[]).map((line) => ({ sku: line.sku, qty: Number(line.qty) })),
    };
    const key = String(row.normalized);
    byNumber.set(key, [...(byNumber.get(key) ?? []), candidate]);
  }
  const mapped = await db.execute<{ tiktok_sku_id: string; variant_sku: string }>(sql`select tiktok_sku_id, variant_sku from tiktok_sku_mappings where is_active`);
  const mappings = new Map(mapped.map((row) => [row.tiktok_sku_id, row.variant_sku]));

  const preview: TikTokBackfillPreview = { backfill, counts: { enrich: 0, create: 0, held: 0, skip: 0, notInTikTok: 0 }, enrich: [], create: [], held: [], skip: [], notInTikTok: [], applied: [] };
  const push = <T>(list: T[], row: T) => {
    if (list.length < TIKTOK_BACKFILL_PREVIEW_LIMIT) list.push(row);
  };
  for (const row of orders) {
    const tiktokOrderId = String(row.tiktok_order_id);
    const status = String(row.status);
    // As the commit: separators are ignored only for an all-digit TikTok id.
    const candidates = (byNumber.get(tiktokOrderId) ?? []).filter((candidate) => candidate.channelOrderNo === tiktokOrderId || /^\d+$/.test(tiktokOrderId));
    // The exact number wins over a spelling with separators (the commit's order, apply.ts).
    const exact = candidates.filter((candidate) => candidate.channelOrderNo === tiktokOrderId);
    // As the commit: a cancelled spelling drops out when there are two.
    const pool = exact.length > 0 ? exact : candidates.length > 1 ? candidates.filter((candidate) => candidate.status !== "cancelled") : candidates;
    if (pool.length > 1 || (pool.length === 0 && candidates.length > 1)) {
      preview.counts.held += 1;
      push(preview.held, { tiktokOrderId, tiktokStatus: status, reason: "duplicate_in_admin", detail: candidates.map((candidate) => candidate.orderNo).join(", ") });
      continue;
    }
    const admin = pool[0] ?? null;
    const collectionTime = date(row.collection_time);
    const decision = decideTikTokOrder({
      status,
      isOnHoldOrder: (row.is_on_hold_order as boolean | null) ?? null,
      paidTime: date(row.paid_time),
      collectionTime,
      cancelTime: date(row.cancel_time),
      updateTime: date(row.latest_update_time)!,
      payload: row.payload as AllowlistedObject,
      mappings,
      admin,
      now,
    });
    if (decision.kind === "skip") {
      preview.counts.skip += 1;
      push(preview.skip, { tiktokOrderId, tiktokStatus: status, reason: decision.reason });
    } else if (decision.kind === "hold") {
      preview.counts.held += 1;
      push(preview.held, { tiktokOrderId, tiktokStatus: status, reason: decision.reason, detail: decision.detail });
    } else if (decision.kind === "create") {
      preview.counts.create += 1;
      push(preview.create, {
        tiktokOrderId,
        tiktokStatus: status,
        orderDate: decision.order.orderDate,
        totalAmount: decision.order.totalAmount,
        pieces: decision.order.lines.reduce((sum, line) => sum + line.qty, 0),
        statusTo: decision.transitions.at(-1) ?? "to_ship",
        shippedBeforeBooks: collectionTime !== null && collectionTime.getTime() < TIKTOK_BACKFILL_FLOOR.getTime(),
      });
    } else {
      preview.counts.enrich += 1;
      push(preview.enrich, {
        tiktokOrderId,
        tiktokStatus: status,
        orderId: admin!.id,
        orderNo: admin!.orderNo,
        typedNumber: admin!.channelOrderNo,
        statusFrom: admin!.status,
        statusTo: decision.transitions.at(-1) ?? admin!.status,
        fillsShippedAt: decision.effects.marketplaceShippedAt !== null,
        fillsCompletedAt: decision.effects.marketplaceCompletedAt !== null,
      });
    }
  }

  const lonely = await db.execute<Row>(sql`
    select o.id, o.order_no, o.channel_order_no, o.order_date, o.status
    from orders o
    where o.channel_id = 'tiktok' and o.created_by_staff_user_id is not null
      and o.order_date >= ${backfill.fromTime.toISOString()}::timestamptz and o.order_date < ${backfill.untilTime.toISOString()}::timestamptz
      and not exists (
        select 1 from tiktok_orders t
        where t.order_id = o.id or t.tiktok_order_id = regexp_replace(o.channel_order_no, ${separators}, '', 'g')
      )
    order by o.order_date, o.order_no
  `);
  preview.counts.notInTikTok = lonely.length;
  preview.notInTikTok = lonely.slice(0, TIKTOK_BACKFILL_PREVIEW_LIMIT).map((row) => ({
    orderId: String(row.id),
    orderNo: String(row.order_no),
    channelOrderNo: String(row.channel_order_no),
    orderDate: date(row.order_date)!,
    status: row.status as OrderStatus,
  }));
  const applied = await db.execute<{ state: TikTokApplyState | null; count: number }>(sql`
    select apply_state as state, count(*)::int as count from tiktok_orders where backfill_id = ${backfill.id}::uuid and apply_state is not null group by apply_state order by apply_state
  `);
  preview.applied = applied.map((row) => ({ state: row.state, count: Number(row.count) }));
  return preview;
}
