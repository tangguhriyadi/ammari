import "server-only";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { orderItems, orders, type OrderAttentionFlag, type OrderStatus, type TikTokHeldReason, type TikTokOrderReviewFlag, type TikTokSnapshotSource } from "@ammari/db/schema";
import type { AllowlistedObject } from "@ammari/tiktok-shop";
import { defaultDb, writeAuditLog, type Database, type Tx } from "../db";
import { ActionError, FieldError, isPostgresConstraintViolation, isPostgresErrorCode } from "../errors";
import { decrementStockForOrderItems, transitionOrderStatus } from "../orders/lifecycle";
import { generateOrderNumber } from "../orders/order-number";
import { decideTikTokOrder, tiktokPackingState, type TikTokDecision, type TikTokEffects, type TikTokNewOrder } from "./apply-rules";
import { TIKTOK_ORDER_NO_SEPARATORS_SQL } from "./backfill";
import { tiktokSnapshotLines } from "./order-store";

// Applying a TikTok order to admin orders and stock (docs/plans/tiktok-shop-integration.md §4.2, T5).
// The decision is pure (apply-rules.ts); this is the one transaction that carries it out:
//
//   1. `pg_advisory_xact_lock(hashtext('tiktok-order:' || id))`, the key the store takes too, so the
//      webhook drain, the poll and the cron's re-check of the same order run one after the other;
//   2. everything is re-read under the lock: the projection and its latest snapshot (FOR UPDATE), the
//      admin order with this TikTok number (FOR UPDATE), its lines, the SKU mappings. Nothing read
//      before the lock is trusted;
//   3. the same version already applied → only the packing gate is re-checked (an hour passing fires
//      no webhook); nothing else is written, so a replay changes nothing;
//   4. a new order: the SKUs are locked in sorted order (the order every other stock path uses), the
//      order is inserted with `ON CONFLICT (channel_id, channel_order_no) DO NOTHING RETURNING` (a
//      hand-typed order that appeared meanwhile is never duplicated), and stock leaves through
//      createOrder's own `decrementStockForOrderItems`, which refuses a sale below zero under the SKU
//      lock. A refusal rolls back the savepoint and the order is held `short_stock`;
//   5. every status move goes through `transitionOrderStatus` (actor NULL: the system), every other
//      change is a conditional UPDATE. The marketplace dates are written once (`coalesce`).
//
// T9 (backfill, enrich mode): an order the backfill was the first to store waits until the owner
// confirms that backfill (`waiting_backfill`, nothing written). A hand-typed order is matched on the
// exact number first, else on the number with spaces, `#`, `.` and `-` removed (only for an all-digit
// TikTok id); such a match corrects the typed number to TikTok's, so every later match and the T8
// reconciliation find it. Two hand-typed orders behind one number are held `duplicate_in_admin` (one of
// them cancelled by staff settles it).
//
// The caller (sync.ts) checks the kill switch (`orders_apply_enabled`) before calling this.

const ROW_LOCK_TIMEOUT = "10s";

export type ApplyTikTokOrderResult =
  | { kind: "created"; orderId: string; stockSkus: string[] }
  | { kind: "updated"; orderId: string; stockSkus: string[] }
  | { kind: "unchanged"; orderId: string | null }
  | { kind: "held"; reason: TikTokHeldReason; detail: string | null }
  | { kind: "skipped"; reason: "unpaid" | "cancelled" }
  | { kind: "not_found" }
  /** T9: the backfill stored it first and is not confirmed yet ("Terapkan riwayat"). Nothing written. */
  | { kind: "waiting_backfill" }
  /** A row lock timed out, a deadlock, or the admin order moved under us: nothing was written;
   * the next pass retries. */
  | { kind: "busy"; code: string };

export interface ApplyTikTokOrderOptions {
  now?: Date;
  /** Recorded in the audit row: where this version came from, or `recheck` (the cron's re-check). */
  source: TikTokSnapshotSource | "recheck";
}

/** Rolls the savepoint back; the commit turns it into `busy`. */
class ApplyDrift extends Error {
  constructor(readonly code: string) {
    super(`tiktok apply drift: ${code}`);
    this.name = "ApplyDrift";
  }
}

/** Rolls the savepoint back; the commit records the hold. */
class ApplyHold extends Error {
  constructor(
    readonly reason: TikTokHeldReason,
    readonly detail: string | null,
  ) {
    super(`tiktok apply held: ${reason}`);
    this.name = "ApplyHold";
  }
}

interface LockedProjection {
  tiktok_order_id: string;
  order_id: string | null;
  status: string;
  latest_update_time: Date;
  paid_time: Date | null;
  collection_time: Date | null;
  cancel_time: Date | null;
  is_on_hold_order: boolean | null;
  apply_state: string | null;
  held_reason: string | null;
  applied_update_time: Date | null;
  review_flags: TikTokOrderReviewFlag[];
  payload: AllowlistedObject;
  /** T9: stored first by a backfill that is not confirmed yet. */
  waiting_backfill: boolean;
}

function toDate(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

async function lockProjection(tx: Tx, tiktokOrderId: string): Promise<LockedProjection | null> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select t.tiktok_order_id, t.order_id, t.status, t.latest_update_time, t.paid_time, t.collection_time, t.cancel_time,
           t.is_on_hold_order, t.apply_state, t.held_reason, t.applied_update_time, t.review_flags, s.payload,
           (t.backfill_id is not null and not exists (select 1 from tiktok_backfills b where b.id = t.backfill_id and b.state = 'confirmed')) as waiting_backfill
    from tiktok_orders t join tiktok_order_snapshots s on s.id = t.latest_snapshot_id
    where t.tiktok_order_id = ${tiktokOrderId}
    for update of t
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    tiktok_order_id: String(row.tiktok_order_id),
    order_id: (row.order_id as string | null) ?? null,
    status: String(row.status),
    latest_update_time: toDate(row.latest_update_time as string)!,
    paid_time: toDate(row.paid_time as string | null),
    collection_time: toDate(row.collection_time as string | null),
    cancel_time: toDate(row.cancel_time as string | null),
    is_on_hold_order: (row.is_on_hold_order as boolean | null) ?? null,
    apply_state: (row.apply_state as string | null) ?? null,
    held_reason: (row.held_reason as string | null) ?? null,
    applied_update_time: toDate(row.applied_update_time as string | null),
    review_flags: (row.review_flags as TikTokOrderReviewFlag[]) ?? [],
    payload: row.payload as AllowlistedObject,
    waiting_backfill: row.waiting_backfill === true,
  };
}

const ADMIN_ORDER_COLUMNS = {
  id: orders.id,
  orderNo: orders.orderNo,
  channelOrderNo: orders.channelOrderNo,
  status: orders.status,
  needsAttention: orders.needsAttention,
  marketplaceShippedAt: orders.marketplaceShippedAt,
  marketplaceCompletedAt: orders.marketplaceCompletedAt,
  marketplaceReturnedAt: orders.marketplaceReturnedAt,
  channelStatus: orders.channelStatus,
};

type LockedAdminOrder = { id: string; orderNo: string; channelOrderNo: string | null; status: OrderStatus; needsAttention: OrderAttentionFlag[]; marketplaceShippedAt: Date | null; marketplaceCompletedAt: Date | null; marketplaceReturnedAt: Date | null; channelStatus: string | null };

/** The admin order this TikTok order belongs to, locked: its link, else the exact number, else (T9) a
 * hand-typed number that differs only by separators, not linked to another TikTok order. `ambiguous`:
 * two such orders (the sync never picks one). */
async function lockAdminOrder(tx: Tx, projection: LockedProjection): Promise<{ order: LockedAdminOrder | null; ambiguous: string[] }> {
  if (projection.order_id) {
    const [order] = await tx.select(ADMIN_ORDER_COLUMNS).from(orders).where(eq(orders.id, projection.order_id)).for("update").limit(1);
    return { order: order ?? null, ambiguous: [] };
  }
  const [exact] = await tx
    .select(ADMIN_ORDER_COLUMNS)
    .from(orders)
    .where(and(eq(orders.channelId, "tiktok"), eq(orders.channelOrderNo, projection.tiktok_order_id)))
    .for("update")
    .limit(1);
  if (exact) return { order: exact, ambiguous: [] };
  if (!/^\d+$/.test(projection.tiktok_order_id)) return { order: null, ambiguous: [] };
  const separators = TIKTOK_ORDER_NO_SEPARATORS_SQL;
  const loose = await tx
    .select(ADMIN_ORDER_COLUMNS)
    .from(orders)
    .where(
      sql`${orders.channelId} = 'tiktok' and regexp_replace(${orders.channelOrderNo}, ${separators}, '', 'g') = ${projection.tiktok_order_id}
        and not exists (select 1 from tiktok_orders t where t.order_id = ${orders.id})`,
    )
    .orderBy(orders.orderNo)
    .for("update")
    .limit(10);
  // Two spellings of one number: one cancelled by staff (the fix the preview suggests) leaves the other.
  const pool = loose.length > 1 ? loose.filter((order) => order.status !== "cancelled") : loose;
  if (pool.length > 1 || (pool.length === 0 && loose.length > 1)) return { order: null, ambiguous: loose.map((order) => order.orderNo) };
  return { order: pool[0] ?? null, ambiguous: [] };
}

async function activeMappings(tx: Tx, payload: AllowlistedObject): Promise<Map<string, string>> {
  const skuIds = [...new Set(tiktokSnapshotLines(payload).map((line) => line.skuId))];
  if (skuIds.length === 0) return new Map();
  const rows = await tx.execute<{ tiktok_sku_id: string; variant_sku: string }>(sql`
    select tiktok_sku_id, variant_sku from tiktok_sku_mappings
    where is_active and tiktok_sku_id in (${sql.join(
      skuIds.map((id) => sql`${id}`),
      sql`, `,
    )})
  `);
  return new Map(rows.map((row) => [row.tiktok_sku_id, row.variant_sku]));
}

/** `needs_attention` with `add` added (each once, in order) and `remove` removed, computed from the
 * row as locked. */
export function flagsExpression(add: readonly OrderAttentionFlag[], remove: readonly OrderAttentionFlag[]): SQL {
  const list = (flags: readonly string[]) =>
    flags.length === 0
      ? sql`array[]::text[]`
      : sql`array[${sql.join(
          flags.map((flag) => sql`${flag}`),
          sql`, `,
        )}]::text[]`;
  return sql`array(select f from unnest(${orders.needsAttention} || ${list(add)}) with ordinality as t(f, i) where not (f = any(${list(remove)})) group by f order by min(i))`;
}

function sameFlags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((flag, index) => flag === b[index]);
}

const STATE_FOR_SKIP = { unpaid: "skipped_unpaid", cancelled: "skipped_undone" } as const;

async function recordState(
  tx: Tx,
  projection: LockedProjection,
  state: "held" | "skipped_unpaid" | "skipped_undone",
  reason: TikTokHeldReason | null,
  detail: string | null,
  source: ApplyTikTokOrderOptions["source"],
  now: Date,
): Promise<void> {
  // `updated_at` = when this hold was last checked: the re-check backs off on it (TIKTOK_HELD_RECHECK_MS).
  if (projection.apply_state === state && projection.held_reason === reason) {
    await tx.execute(sql`update tiktok_orders set updated_at = ${now.toISOString()}::timestamptz where tiktok_order_id = ${projection.tiktok_order_id}`);
    return;
  }
  await tx.execute(sql`
    update tiktok_orders set apply_state = ${state}, held_reason = ${reason}, updated_at = ${now.toISOString()}::timestamptz
    where tiktok_order_id = ${projection.tiktok_order_id}
  `);
  const before = { applyState: projection.apply_state, heldReason: projection.held_reason };
  const after = { applyState: state, reason, detail, tiktokStatus: projection.status, source };
  if (state === "held") {
    await writeAuditLog(tx, { actorStaffUserId: null, action: "tiktok_hold", entityType: "tiktok_order", entityId: projection.tiktok_order_id, before, after });
  } else {
    await writeAuditLog(tx, { actorStaffUserId: null, action: "tiktok_skip", entityType: "tiktok_order", entityId: projection.tiktok_order_id, before, after });
  }
}

/** One status step through the only status path. A refusal means the order moved under us. Only the
 * sale step (`awaiting_payment → to_ship`) can refuse for stock (a FieldError naming the SKU). */
async function step(tx: Tx, orderId: string, to: OrderStatus): Promise<void> {
  try {
    await transitionOrderStatus(orderId, to, null, tx);
  } catch (error) {
    if (error instanceof FieldError && to === "to_ship") throw new ApplyHold("short_stock", error.field);
    if (error instanceof FieldError) throw new ApplyDrift(`transition_${to}_field_error`);
    if (error instanceof ActionError) throw new ApplyDrift(`transition_${to}_refused`);
    throw error;
  }
}

async function createAdminOrder(tx: Tx, projection: LockedProjection, order: TikTokNewOrder, now: Date): Promise<{ id: string; orderNo: string; items: { id: string; sku: string; qty: number }[] }> {
  // The order number's month lock first, then the SKUs (sorted, one at a time, inside
  // decrementStockForOrderItems): the same order checkout and manual entry take, so no deadlock.
  const orderNo = await generateOrderNumber(tx, now);
  const [inserted] = await tx
    .insert(orders)
    .values({
      channelId: "tiktok",
      orderNo,
      channelOrderNo: projection.tiktok_order_id,
      status: "to_ship",
      orderDate: order.orderDate,
      subtotalAmount: order.subtotalAmount,
      shippingAmount: 0,
      discountAmount: order.discountAmount,
      totalAmount: order.totalAmount,
      // TikTok orders carry no buyer data at all (plan §6, the import's decision 9).
      customerId: null,
      buyerUsername: null,
      shippingAddress: null,
      notes: null,
      createdByStaffUserId: null,
      channelStatus: projection.status,
      channelSyncedAt: now,
    })
    .onConflictDoNothing({ target: [orders.channelId, orders.channelOrderNo] })
    .returning({ id: orders.id });
  // A hand-typed order with this number appeared after our read: the next pass matches it.
  if (!inserted) throw new ApplyDrift("order_exists");
  const items = await tx
    .insert(orderItems)
    .values(order.lines.map((line) => ({ orderId: inserted.id, sku: line.sku, qty: line.qty, unitPrice: line.unitPrice, listUnitPrice: null, unitCost: 0 })))
    .returning({ id: orderItems.id, sku: orderItems.sku, qty: orderItems.qty });
  try {
    await decrementStockForOrderItems(tx, items, null);
  } catch (error) {
    if (error instanceof FieldError) throw new ApplyHold("short_stock", error.field);
    throw error;
  }
  return { id: inserted.id, orderNo, items };
}

interface OrderChange {
  flagsBefore: OrderAttentionFlag[];
  flagsAfter: OrderAttentionFlag[];
  datesWritten: Record<string, string>;
  channelStatusChanged: boolean;
}

/** Flags, write-once dates and channel status after the transitions. */
async function applyEffects(tx: Tx, orderId: string, effects: TikTokEffects, tiktokStatus: string, now: Date): Promise<OrderChange> {
  const [before] = await tx
    .select({ needsAttention: orders.needsAttention, shipped: orders.marketplaceShippedAt, completed: orders.marketplaceCompletedAt, returned: orders.marketplaceReturnedAt, channelStatus: orders.channelStatus })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!before) throw new ApplyDrift("order_gone");
  const [after] = await tx
    .update(orders)
    .set({
      needsAttention: flagsExpression(effects.addFlags, effects.removeFlags),
      ...(effects.marketplaceShippedAt ? { marketplaceShippedAt: sql`coalesce(${orders.marketplaceShippedAt}, ${effects.marketplaceShippedAt.toISOString()}::timestamptz)` } : {}),
      ...(effects.marketplaceCompletedAt ? { marketplaceCompletedAt: sql`coalesce(${orders.marketplaceCompletedAt}, ${effects.marketplaceCompletedAt.toISOString()}::timestamptz)` } : {}),
      ...(effects.marketplaceReturnedAt ? { marketplaceReturnedAt: sql`coalesce(${orders.marketplaceReturnedAt}, ${effects.marketplaceReturnedAt.toISOString()}::timestamptz)` } : {}),
      channelStatus: tiktokStatus,
      channelSyncedAt: now,
    })
    .where(eq(orders.id, orderId))
    .returning({ needsAttention: orders.needsAttention, shipped: orders.marketplaceShippedAt, completed: orders.marketplaceCompletedAt, returned: orders.marketplaceReturnedAt });
  const datesWritten: Record<string, string> = {};
  const written = (key: string, was: Date | null, is: Date | null) => {
    if (was === null && is !== null) datesWritten[key] = is.toISOString();
  };
  written("marketplaceShippedAt", before.shipped, after!.shipped);
  written("marketplaceCompletedAt", before.completed, after!.completed);
  written("marketplaceReturnedAt", before.returned, after!.returned);
  return { flagsBefore: before.needsAttention, flagsAfter: after!.needsAttention, datesWritten, channelStatusChanged: before.channelStatus !== tiktokStatus };
}

async function markApplied(tx: Tx, projection: LockedProjection, orderId: string, reviewFlags: readonly TikTokOrderReviewFlag[]): Promise<TikTokOrderReviewFlag[]> {
  const added = reviewFlags.filter((flag) => !projection.review_flags.includes(flag));
  const addedList =
    added.length === 0
      ? sql`array[]::text[]`
      : sql`array[${sql.join(
          added.map((flag) => sql`${flag}`),
          sql`, `,
        )}]::text[]`;
  await tx.execute(sql`
    update tiktok_orders set order_id = ${orderId}::uuid, apply_state = 'applied', held_reason = null,
      applied_update_time = latest_update_time, review_flags = review_flags || ${addedList}, updated_at = now()
    where tiktok_order_id = ${projection.tiktok_order_id}
  `);
  return added;
}

function stockSkusOf(decision: TikTokDecision, lines: readonly { sku: string }[]): string[] {
  if (decision.kind === "create") return decision.order.lines.map((line) => line.sku);
  if (decision.kind !== "update") return [];
  const moves = decision.transitions.some((to) => to === "to_ship" || to === "cancelled" || to === "returned");
  return moves ? [...new Set(lines.map((line) => line.sku))].sort() : [];
}

async function commit(tx: Tx, tiktokOrderId: string, options: Required<ApplyTikTokOrderOptions>): Promise<ApplyTikTokOrderResult> {
  const { now, source } = options;
  // lock_timeout first: it bounds the advisory lock wait too (a stalled store or apply of the same
  // order), which then ends as `busy: lock_timeout` instead of holding the cron past its budget.
  await tx.execute(sql`select set_config('lock_timeout', ${ROW_LOCK_TIMEOUT}, true)`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tiktok-order:${tiktokOrderId}`}))`);
  const projection = await lockProjection(tx, tiktokOrderId);
  if (!projection) return { kind: "not_found" };
  if (projection.waiting_backfill) return { kind: "waiting_backfill" };
  const located = await lockAdminOrder(tx, projection);
  if (located.ambiguous.length > 0) {
    await recordState(tx, projection, "held", "duplicate_in_admin", located.ambiguous.join(", ").slice(0, 200), source, now);
    return { kind: "held", reason: "duplicate_in_admin", detail: located.ambiguous.join(", ") };
  }
  const admin = located.order;

  const sameVersion = projection.applied_update_time !== null && projection.applied_update_time.getTime() === projection.latest_update_time.getTime();
  if (sameVersion && projection.apply_state === "applied" && admin) {
    // Only the packing gate can change without a new version (an hour passing).
    const waiting = admin.status === "to_ship" && tiktokPackingState({ status: projection.status, isOnHoldOrder: projection.is_on_hold_order, paidTime: projection.paid_time }, now).kind === "wait";
    const flagged = admin.needsAttention.includes("tiktok_on_hold");
    if (flagged === waiting) return { kind: "unchanged", orderId: admin.id };
    const change = await applyEffects(tx, admin.id, { addFlags: waiting ? ["tiktok_on_hold"] : [], removeFlags: waiting ? [] : ["tiktok_on_hold"], marketplaceShippedAt: null, marketplaceCompletedAt: null, marketplaceReturnedAt: null, reviewFlags: [] }, projection.status, now);
    await writeAuditLog(tx, {
      actorStaffUserId: null,
      action: "tiktok_update",
      entityType: "order",
      entityId: admin.id,
      before: { needsAttention: change.flagsBefore },
      after: { source, tiktokOrderId, tiktokStatus: projection.status, needsAttention: change.flagsAfter, reason: "packing_gate" },
    });
    return { kind: "updated", orderId: admin.id, stockSkus: [] };
  }
  if (sameVersion && (projection.apply_state === "skipped_unpaid" || projection.apply_state === "skipped_undone") && !admin) {
    return { kind: "unchanged", orderId: null };
  }

  const lines = admin ? await tx.select({ sku: orderItems.sku, qty: orderItems.qty }).from(orderItems).where(eq(orderItems.orderId, admin.id)) : [];
  const decision = decideTikTokOrder({
    status: projection.status,
    isOnHoldOrder: projection.is_on_hold_order,
    paidTime: projection.paid_time,
    collectionTime: projection.collection_time,
    cancelTime: projection.cancel_time,
    updateTime: projection.latest_update_time,
    payload: projection.payload,
    mappings: await activeMappings(tx, projection.payload),
    admin: admin
      ? {
          status: admin.status,
          lines,
          needsAttention: admin.needsAttention,
          marketplaceShippedAt: admin.marketplaceShippedAt,
          marketplaceCompletedAt: admin.marketplaceCompletedAt,
          marketplaceReturnedAt: admin.marketplaceReturnedAt,
        }
      : null,
    now,
  });

  if (decision.kind === "skip") {
    await recordState(tx, projection, STATE_FOR_SKIP[decision.reason], null, null, source, now);
    // The version is settled: the cron's re-check does not pick it up again.
    await tx.execute(sql`update tiktok_orders set applied_update_time = latest_update_time where tiktok_order_id = ${tiktokOrderId}`);
    return { kind: "skipped", reason: decision.reason };
  }
  if (decision.kind === "hold") {
    await recordState(tx, projection, "held", decision.reason, decision.detail, source, now);
    return { kind: "held", reason: decision.reason, detail: decision.detail };
  }

  try {
    // A savepoint: a refused sale or a moved order rolls back only this, and the hold is recorded.
    return await tx.transaction(async (sp) => {
      if (decision.kind === "create") {
        const created = await createAdminOrder(sp, projection, decision.order, now);
        for (const to of decision.transitions) await step(sp, created.id, to);
        const change = await applyEffects(sp, created.id, decision.effects, projection.status, now);
        const reviewAdded = await markApplied(sp, projection, created.id, decision.effects.reviewFlags);
        await writeAuditLog(sp, {
          actorStaffUserId: null,
          action: "tiktok_create",
          entityType: "order",
          entityId: created.id,
          after: {
            source,
            tiktokOrderId,
            tiktokStatus: projection.status,
            orderNo: created.orderNo,
            status: decision.transitions.at(-1) ?? "to_ship",
            orderDate: decision.order.orderDate.toISOString(),
            lines: decision.order.lines,
            subtotalAmount: decision.order.subtotalAmount,
            discountAmount: decision.order.discountAmount,
            totalAmount: decision.order.totalAmount,
            needsAttention: change.flagsAfter,
            ...change.datesWritten,
            reviewFlags: reviewAdded,
          },
        });
        return { kind: "created", orderId: created.id, stockSkus: stockSkusOf(decision, decision.order.lines) };
      }

      const orderId = admin!.id;
      // A hand-typed number with separators becomes TikTok's own (conditional: never over a change).
      // Only a first (loose) match: a linked order's number is never touched again.
      const renamed = projection.order_id === null && admin!.channelOrderNo !== tiktokOrderId;
      if (renamed) {
        const fixed = await sp.execute(sql`update orders set channel_order_no = ${tiktokOrderId} where id = ${orderId}::uuid and channel_order_no is not distinct from ${admin!.channelOrderNo} returning id`);
        if (fixed.length === 0) throw new ApplyDrift("order_number_moved");
      }
      for (const to of decision.transitions) await step(sp, orderId, to);
      const change = await applyEffects(sp, orderId, decision.effects, projection.status, now);
      const linked = projection.order_id !== orderId;
      const reviewAdded = await markApplied(sp, projection, orderId, decision.effects.reviewFlags);
      const changed = decision.transitions.length > 0 || !sameFlags(change.flagsBefore, change.flagsAfter) || Object.keys(change.datesWritten).length > 0 || linked || reviewAdded.length > 0 || change.channelStatusChanged || renamed;
      if (changed) {
        await writeAuditLog(sp, {
          actorStaffUserId: null,
          action: "tiktok_update",
          entityType: "order",
          entityId: orderId,
          before: { status: admin!.status, needsAttention: change.flagsBefore, channelStatus: admin!.channelStatus, ...(renamed ? { channelOrderNo: admin!.channelOrderNo } : {}) },
          after: {
            source,
            tiktokOrderId,
            tiktokStatus: projection.status,
            status: decision.transitions.at(-1) ?? admin!.status,
            needsAttention: change.flagsAfter,
            ...change.datesWritten,
            ...(linked ? { matchedHandTypedOrder: projection.order_id === null } : {}),
            ...(renamed ? { channelOrderNo: tiktokOrderId } : {}),
            reviewFlags: reviewAdded,
          },
        });
      }
      return changed ? { kind: "updated", orderId, stockSkus: stockSkusOf(decision, lines) } : { kind: "unchanged", orderId };
    });
  } catch (error) {
    if (error instanceof ApplyHold) {
      await recordState(tx, projection, "held", error.reason, error.detail, source, now);
      return { kind: "held", reason: error.reason, detail: error.detail };
    }
    throw error;
  }
}

/** Applies the latest stored version of one TikTok order. Idempotent: the same version applied
 * again writes nothing (beyond the packing gate re-check). Throws only for a database or
 * programming failure; a lock timeout, a deadlock or an order that moved under the lock is `busy`
 * (nothing written, the next pass retries). */
export async function applyTikTokOrder(db: Database, tiktokOrderId: string, options: ApplyTikTokOrderOptions): Promise<ApplyTikTokOrderResult> {
  const resolved = { now: options.now ?? new Date(), source: options.source };
  try {
    return await db.transaction((tx) => commit(tx, tiktokOrderId, resolved));
  } catch (error) {
    if (error instanceof ApplyDrift) return { kind: "busy", code: error.code };
    // 55P03 lock_not_available (lock_timeout), 40P01 deadlock_detected: rolled back, try again.
    if (isPostgresErrorCode(error, "55P03")) return { kind: "busy", code: "lock_timeout" };
    if (isPostgresErrorCode(error, "40P01")) return { kind: "busy", code: "deadlock" };
    // 23505: the corrected number (T9) or a new order's number already exists: a hand entry landed
    // meanwhile. Rolled back; the next pass matches it.
    // Only that key: any other unique violation is not a race and is thrown (route 500, ALERT).
    if (isPostgresConstraintViolation(error, "23505", ["orders_channel_id_channel_order_no_key"])) return { kind: "busy", code: "order_exists" };
    throw error;
  }
}

export const TIKTOK_RECHECK_LIMIT = 200;
/** A held order is re-checked at most this often (a new version from TikTok is applied as soon as it
 * is stored, whatever this says). Keeps a pile of holds from re-taking locks every run. */
export const TIKTOK_HELD_RECHECK_MS = 15 * 60_000;

/** The TikTok orders the cron re-checks each run (plan §9 step 3): never applied, a newer version
 * than the one applied, applied and still waiting at the packing gate (the hour passes without a
 * webhook), and held. Held orders come last (newest first), so a pile of long-standing holds (an
 * unmapped SKU nobody maps) never starves new work. `truncated`: more were due than `limit`. */
export async function listTikTokOrdersToApply(db: Database, now: Date = new Date(), limit = TIKTOK_RECHECK_LIMIT): Promise<{ ids: string[]; truncated: boolean }> {
  const heldBefore = new Date(now.getTime() - TIKTOK_HELD_RECHECK_MS).toISOString();
  const rows = await db.execute<{ tiktok_order_id: string }>(sql`
    select t.tiktok_order_id from tiktok_orders t
    left join orders o on o.id = t.order_id
    -- T9: an order the backfill stored first waits for "Terapkan riwayat".
    where (t.backfill_id is null or exists (select 1 from tiktok_backfills b where b.id = t.backfill_id and b.state = 'confirmed'))
      and (t.apply_state is null
       or (t.apply_state = 'held' and t.updated_at <= ${heldBefore}::timestamptz)
       or (t.apply_state <> 'held' and (t.applied_update_time is null or t.applied_update_time < t.latest_update_time))
       -- Any status: a TikTok hold left on an order staff shipped meanwhile is cleared too.
       or 'tiktok_on_hold' = any(o.needs_attention))
    order by (t.apply_state = 'held') nulls first,
             case when t.apply_state = 'held' then null else t.latest_update_time end asc,
             t.latest_update_time desc, t.tiktok_order_id
    limit ${limit + 1}
  `);
  return { ids: rows.slice(0, limit).map((row) => row.tiktok_order_id), truncated: rows.length > limit };
}

/** The kill switch (migration 0059): whether the active connection applies orders. */
export async function tiktokOrdersApplyEnabled(db: Database = defaultDb): Promise<boolean> {
  const rows = await db.execute<{ enabled: boolean }>(sql`select orders_apply_enabled as enabled from tiktok_shop_connections where status = 'active' limit 1`);
  return rows[0]?.enabled === true;
}

export type SetTikTokOrdersApplyResult = { ok: true; changed: boolean } | { ok: false; reason: "not_connected" };

/** Turns applying on or off (Integrasi TikTok Shop, `integrations.manage`). Audited. */
export async function setTikTokOrdersApply(db: Database, input: { enabled: boolean; staffUserId: string; now?: Date }): Promise<SetTikTokOrdersApplyResult> {
  return db.transaction(async (tx) => {
    // Turning it on needs an active connection; turning it off works on the current connection
    // whatever its state (a reconnect keeps the row, and with it the switch), so a lost connection
    // never leaves applying on with no way to stop it.
    const rows = await tx.execute<{ id: string; orders_apply_enabled: boolean }>(sql`
      select id, orders_apply_enabled from tiktok_shop_connections
      where ${input.enabled ? sql`status = 'active'` : sql`status = 'active' or orders_apply_enabled`}
      order by case when status = 'active' then 0 else 1 end, updated_at desc
      limit 1 for update
    `);
    const row = rows[0];
    if (!row) return { ok: false, reason: "not_connected" };
    if (row.orders_apply_enabled === input.enabled) return { ok: true, changed: false };
    const at = (input.now ?? new Date()).toISOString();
    await tx.execute(sql`
      update tiktok_shop_connections set orders_apply_enabled = ${input.enabled}, orders_apply_changed_at = ${at}::timestamptz,
        orders_apply_changed_by_staff_user_id = ${input.staffUserId}::uuid, updated_at = now()
      where id = ${row.id}::uuid
    `);
    await writeAuditLog(tx, {
      actorStaffUserId: input.staffUserId,
      action: input.enabled ? "tiktok_apply_enable" : "tiktok_apply_disable",
      entityType: "tiktok_shop_connection",
      entityId: row.id,
      before: { ordersApplyEnabled: row.orders_apply_enabled },
      after: { ordersApplyEnabled: input.enabled },
    });
    return { ok: true, changed: true };
  });
}
