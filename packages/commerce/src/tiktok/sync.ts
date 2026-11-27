import "server-only";
import { sql } from "drizzle-orm";
import {
  ORDER_DETAIL_MAX_IDS,
  Secret,
  TikTokApiError,
  getTikTokOrderDetails,
  isTikTokOrderId,
  searchTikTokOrders,
  type TikTokAuthClient,
  type TikTokClient,
  type TikTokErrorKind,
  type TokenKeyring,
} from "@ammari/tiktok-shop";
import type { TikTokSnapshotSource } from "@ammari/db/schema";
import type { Database } from "../db";
import { getTikTokConnectionView, loadTikTokCredentials, refreshTikTokToken, tiktokErrorCode } from "./connection";
import { ingestTikTokOrder } from "./order-store";
import { planTikTokPollWindows } from "./order-windows";
import { TIKTOK_WEBHOOK_MAX_ATTEMPTS, TIKTOK_WEBHOOK_TOPICS, processDueTikTokConnectionEvents } from "./webhook";

// The TikTok sync run (docs/plans/tiktok-shop-integration.md §4.1, §8.2, §8.3, §9; T4), called by
// apps/web's `POST /api/internal/tiktok/sync` under the shared cron lock, and (one event at a time)
// by the webhook route after its answer. READ SIDE ONLY: TikTok orders are fetched, allowlisted and
// stored as snapshots + projection; no admin order, stock or journal is written (T5).
//
// Steps per run, each within the time budget (stops starting new TikTok calls after 150 s, §8.2):
//   1. topic 6/7 inbox events that are due (a retry, or one whose `after()` was lost; T3 left this
//      to the cron);
//   2. refresh the token when it has < 24 h left;
//   3. drain the inbox: topics 1, 11 and 12 are refresh triggers only. The body is never trusted;
//      the order is re-fetched with Get Order Detail (§4.1). Claimed with FOR UPDATE SKIP LOCKED and
//      a lease, retried with backoff, `failed` after 10 attempts (§8.3);
//   4. the reconciliation poll: Search Orders over `update_time` windows (order-windows.ts), every
//      page, then Get Order Detail in batches of ≤ 50. The cursor moves to a slice's end only once
//      every order of that slice is stored.
// T5 adds step "re-check held orders and the packing gate"; T6 the cancellation/return polls; T7
// finance. Nothing here logs: the route logs the summary (codes only, never a body or a token).

export const TIKTOK_SYNC_BUDGET_MS = 150_000;
/** The webhook's `after()` drain of one order. */
export const TIKTOK_WEBHOOK_DRAIN_BUDGET_MS = 20_000;
/** Inbox events claimed per run. */
export const TIKTOK_INBOX_BATCH = 100;
/** A claimed event is invisible to other drains this long (longer than a run's budget). */
export const TIKTOK_INBOX_LEASE_MS = 10 * 60_000;
/** A runaway pagination (a token TikTok keeps handing back) stops here. */
export const TIKTOK_MAX_PAGES_PER_SLICE = 500;

const ORDER_TOPICS = [TIKTOK_WEBHOOK_TOPICS.ORDER_STATUS_CHANGE, TIKTOK_WEBHOOK_TOPICS.CANCELLATION_STATUS_CHANGE, TIKTOK_WEBHOOK_TOPICS.RETURN_STATUS_CHANGE] as const;
const ORDER_TOPICS_SQL = sql.raw(ORDER_TOPICS.join(", "));

export interface TikTokSyncDeps {
  api: TikTokClient;
  auth: TikTokAuthClient;
  keyring: TokenKeyring;
  now?: () => Date;
}

export interface TikTokOrderCounts {
  /** Orders returned by Get Order Detail and stored. */
  fetched: number;
  snapshotsInserted: number;
  replays: number;
  conflicts: number;
  projectionsAdvanced: number;
  /** Ids TikTok did not return. */
  missing: number;
  /** Orders (or search ids) TikTok returned without a usable id, status or update_time. */
  invalid: number;
  /** Orders returned but not storable (a value Postgres refuses, a database error). */
  storeFailed: number;
  autoMapped: number;
}

export interface TikTokSyncSummary {
  connection: "active" | "not_connected" | "reauth_required";
  connectionEvents: { processed: number; notApplied: number };
  tokenRefresh: string | null;
  inbox: { claimed: number; processed: number; ignored: number; retried: number; failed: number; released: number };
  poll: { slices: number; slicesDone: number; pages: number; orderIds: number; caughtUp: boolean; windowEnd: string | null };
  orders: TikTokOrderCounts;
  budgetExhausted: boolean;
  /** What stopped the run: a TikTok error's kind and code, or `incomplete` (orders of a slice
   * not stored; the cursor stayed). Never a message or a body. */
  error: { kind: TikTokErrorKind | "incomplete"; code: string } | null;
  /** Order ids that were not stored, and why (at most 20 per step). */
  problems: { id: string; problem: TikTokOrderProblem }[];
}

function emptyCounts(): TikTokOrderCounts {
  return { fetched: 0, snapshotsInserted: 0, replays: 0, conflicts: 0, projectionsAdvanced: 0, missing: 0, invalid: 0, storeFailed: 0, autoMapped: 0 };
}

function emptySummary(): TikTokSyncSummary {
  return {
    connection: "not_connected",
    connectionEvents: { processed: 0, notApplied: 0 },
    tokenRefresh: null,
    inbox: { claimed: 0, processed: 0, ignored: 0, retried: 0, failed: 0, released: 0 },
    poll: { slices: 0, slicesDone: 0, pages: 0, orderIds: 0, caughtUp: false, windowEnd: null },
    orders: emptyCounts(),
    budgetExhausted: false,
    error: null,
    problems: [],
  };
}

/** The credentials one run uses; an auth error refreshes them in place (one refresh per request). */
interface Session {
  db: Database;
  deps: TikTokSyncDeps;
  clock: () => Date;
  deadline: number;
  shopCipher: string;
  accessToken: Secret;
  tokenGeneration: number;
  counts: TikTokOrderCounts;
}

async function openSession(db: Database, deps: TikTokSyncDeps, clock: () => Date, deadline: number, counts: TikTokOrderCounts): Promise<Session | "not_connected" | "reauth_required"> {
  const credentials = await loadTikTokCredentials(db, deps.keyring, clock());
  if (!credentials.ok) {
    if (credentials.reason === "reauth_required") return "reauth_required";
    const view = await getTikTokConnectionView(db);
    return view?.status === "reauth_required" ? "reauth_required" : "not_connected";
  }
  const { shopCipher, accessToken, tokenGeneration } = credentials.credentials;
  return { db, deps, clock, deadline, shopCipher, accessToken, tokenGeneration, counts };
}

function onAuthError(session: Session, path: string): () => Promise<Secret> {
  return async () => {
    const outcome = await refreshTikTokToken(session.db, { auth: session.deps.auth, keyring: session.deps.keyring, now: session.clock }, { force: true, seenGeneration: session.tokenGeneration });
    if (outcome.kind === "reauth_required" || outcome.kind === "not_connected") {
      throw new TikTokApiError({ kind: "reauth_required", path, httpStatus: null, code: null, requestId: null });
    }
    if (outcome.kind === "failed") throw new Error(`tiktok token refresh failed: ${outcome.errorCode}`);
    const credentials = await loadTikTokCredentials(session.db, session.deps.keyring, session.clock());
    if (!credentials.ok) throw new TikTokApiError({ kind: "reauth_required", path, httpStatus: null, code: null, requestId: null });
    session.accessToken = credentials.credentials.accessToken;
    session.tokenGeneration = credentials.credentials.tokenGeneration;
    return session.accessToken;
  };
}

function shopCall(session: Session, path: string) {
  return { accessToken: session.accessToken, shopCipher: session.shopCipher, deadline: session.deadline, onAuthError: onAuthError(session, path) };
}

function budgetLeft(session: Session): boolean {
  return session.clock().getTime() < session.deadline;
}

function budgetError(path: string): TikTokApiError {
  return new TikTokApiError({ kind: "budget_exhausted", path, httpStatus: null, code: null, requestId: null });
}

/** Why an order a TikTok answer named was not stored. Ids only, never content. */
export type TikTokOrderProblem = "order_missing" | "order_invalid" | "store_failed";

interface FetchOutcome {
  stored: Set<string>;
  problems: Map<string, TikTokOrderProblem>;
}

function newOutcome(): FetchOutcome {
  return { stored: new Set(), problems: new Map() };
}

/** Get Order Detail for `ids` in batches of ≤ 50, storing every order returned. Fills `outcome`
 * as it goes (so a caller that catches a TikTokApiError mid-way still knows what was stored). An
 * id TikTok did not return (`order_missing`), returned unusable (`order_invalid`) or that failed to
 * store (`store_failed`, e.g. a value Postgres refuses) is recorded, never dropped, and one bad
 * order never stops the others. */
async function syncTikTokOrdersById(session: Session, ids: readonly string[], source: TikTokSnapshotSource, outcome: FetchOutcome): Promise<void> {
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += ORDER_DETAIL_MAX_IDS) {
    if (!budgetLeft(session)) throw budgetError("/order/detail");
    const batch = unique.slice(start, start + ORDER_DETAIL_MAX_IDS);
    const details = await getTikTokOrderDetails(session.deps.api, batch, shopCall(session, "/order/detail"));
    for (const order of details.orders) {
      try {
        const result = await ingestTikTokOrder(session.db, order, source, session.clock());
        outcome.stored.add(order.tiktokOrderId);
        session.counts.fetched += 1;
        if (result.snapshot === "inserted") session.counts.snapshotsInserted += 1;
        else if (result.snapshot === "replay") session.counts.replays += 1;
        else session.counts.conflicts += 1;
        if (result.projection !== "unchanged") session.counts.projectionsAdvanced += 1;
        session.counts.autoMapped += result.autoMapped.length;
      } catch {
        // The error itself is dropped: a driver message can quote the payload. The id is kept.
        outcome.problems.set(order.tiktokOrderId, "store_failed");
        session.counts.storeFailed += 1;
      }
    }
    for (const id of details.invalid) if (id) outcome.problems.set(id, "order_invalid");
    session.counts.invalid += details.invalid.length;
    for (const id of batch) {
      if (outcome.stored.has(id) || outcome.problems.has(id)) continue;
      outcome.problems.set(id, "order_missing");
      session.counts.missing += 1;
    }
  }
}

/** Up to 20 problem ids for the summary (TikTok order ids, not buyer data). */
function problemSample(problems: Map<string, TikTokOrderProblem>): { id: string; problem: TikTokOrderProblem }[] {
  return [...problems].slice(0, 20).map(([id, problem]) => ({ id, problem }));
}

// ---- Inbox (topics 1, 11, 12) ---------------------------------------------------------------

type ClaimedEvent = {
  id: string;
  tiktok_order_id: string | null;
  attempts: number;
};

async function claimOrderEvents(db: Database, now: Date, options: { eventId?: string; limit: number }): Promise<ClaimedEvent[]> {
  const leaseUntil = new Date(now.getTime() + TIKTOK_INBOX_LEASE_MS).toISOString();
  return db.execute<ClaimedEvent>(sql`
    update tiktok_webhook_events e set next_attempt_at = ${leaseUntil}::timestamptz
    where e.id in (
      select id from tiktok_webhook_events
      where status = 'pending' and type in (${ORDER_TOPICS_SQL})
        and (next_attempt_at is null or next_attempt_at <= ${now.toISOString()}::timestamptz)
        ${options.eventId ? sql`and id = ${options.eventId}::uuid` : sql``}
      order by received_at
      limit ${options.limit}
      for update skip locked
    )
    returning e.id, e.tiktok_order_id, e.attempts
  `);
}

/** `id in (...)` for a non-empty list (drizzle binds each element as its own parameter). */
function idList(ids: readonly string[]) {
  return sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

async function markEvents(db: Database, ids: string[], status: "processed" | "ignored", now: Date, note: string | null): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db.execute(sql`
    update tiktok_webhook_events set status = ${status}, processed_at = ${now.toISOString()}::timestamptz, next_attempt_at = null, last_error_code = ${note}
    where id in ${idList(ids)} and status = 'pending'
    returning id
  `);
  return rows.length;
}

/** The claim is given back without counting an attempt (the run ran out of time before it). */
async function releaseEvents(db: Database, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db.execute(sql`update tiktok_webhook_events set next_attempt_at = null where id in ${idList(ids)} and status = 'pending' returning id`);
  return rows.length;
}

/** One more attempt: backoff 1, 2, 4 ... minutes (≤ 6 h, as T3), `failed` after the 10th. */
async function retryEvents(db: Database, ids: string[], now: Date, code: string): Promise<{ retried: number; failed: number }> {
  if (ids.length === 0) return { retried: 0, failed: 0 };
  const rows = await db.execute<{ status: string }>(sql`
    update tiktok_webhook_events set
      attempts = least(attempts + 1, ${TIKTOK_WEBHOOK_MAX_ATTEMPTS}),
      status = case when attempts + 1 >= ${TIKTOK_WEBHOOK_MAX_ATTEMPTS} then 'failed' else 'pending' end,
      next_attempt_at = case when attempts + 1 >= ${TIKTOK_WEBHOOK_MAX_ATTEMPTS} then null
        else ${now.toISOString()}::timestamptz + make_interval(secs => least(60 * power(2, attempts), 21600)) end,
      last_error_code = ${code.slice(0, 64)}
    where id in ${idList(ids)} and status = 'pending'
    returning status
  `);
  const failed = rows.filter((row) => row.status === "failed").length;
  return { retried: rows.length - failed, failed };
}

async function drainOrderEvents(session: Session, summary: TikTokSyncSummary, options: { eventId?: string; limit: number }): Promise<void> {
  const db = session.db;
  const claimed = await claimOrderEvents(db, session.clock(), options);
  summary.inbox.claimed += claimed.length;
  if (claimed.length === 0) return;
  // A signed event without an order id has nothing to refresh; one whose id TikTok's detail call
  // could never take (T3 stores any printable id) is settled too, with its code. The poll covers both.
  const withoutOrder = claimed.filter((event) => !event.tiktok_order_id).map((event) => event.id);
  summary.inbox.ignored += await markEvents(db, withoutOrder, "ignored", session.clock(), "no_order_id");
  const badId = claimed.filter((event) => event.tiktok_order_id && !isTikTokOrderId(event.tiktok_order_id)).map((event) => event.id);
  summary.inbox.ignored += await markEvents(db, badId, "ignored", session.clock(), "invalid_order_id");
  const withOrder = claimed.filter((event) => event.tiktok_order_id && isTikTokOrderId(event.tiktok_order_id));
  if (withOrder.length === 0) return;

  const outcome = newOutcome();
  const settle = async (pendingCode: string | null) => {
    const stored = withOrder.filter((event) => outcome.stored.has(event.tiktok_order_id!)).map((event) => event.id);
    summary.inbox.processed += await markEvents(db, stored, "processed", session.clock(), null);
    // Not stored: one more attempt each, with the reason; `failed` (visible) after the 10th.
    const byCode = new Map<string, string[]>();
    for (const event of withOrder) {
      if (outcome.stored.has(event.tiktok_order_id!)) continue;
      const code = outcome.problems.get(event.tiktok_order_id!) ?? pendingCode;
      if (code === null) continue;
      byCode.set(code, [...(byCode.get(code) ?? []), event.id]);
    }
    for (const [code, ids] of byCode) {
      const counted = await retryEvents(db, ids, session.clock(), code);
      summary.inbox.retried += counted.retried;
      summary.inbox.failed += counted.failed;
    }
  };

  try {
    await syncTikTokOrdersById(session, withOrder.map((event) => event.tiktok_order_id!), "webhook", outcome);
    summary.problems.push(...problemSample(outcome.problems));
    await settle(null);
  } catch (error) {
    summary.problems.push(...problemSample(outcome.problems));
    if (error instanceof TikTokApiError && error.kind === "budget_exhausted") {
      // Stored ones are done; the rest go back without counting an attempt.
      const stored = withOrder.filter((event) => outcome.stored.has(event.tiktok_order_id!)).map((event) => event.id);
      summary.inbox.processed += await markEvents(db, stored, "processed", session.clock(), null);
      summary.inbox.released += await releaseEvents(db, withOrder.filter((event) => !outcome.stored.has(event.tiktok_order_id!)).map((event) => event.id));
    } else {
      try {
        await settle(error instanceof TikTokApiError ? tiktokErrorCode(error) : "sync_failed");
      } catch {
        // Recording failed too (database down): the lease runs out and the next drain retries.
      }
    }
    throw error;
  }
}

// ---- Reconciliation poll --------------------------------------------------------------------

/** A slice had orders that could not be stored: the cursor stays, the run reports the code. */
class SyncIncomplete extends Error {
  constructor(readonly code: TikTokOrderProblem) {
    super(`tiktok sync incomplete: ${code}`);
    this.name = "SyncIncomplete";
  }
}

async function readOrdersCursor(db: Database, now: Date): Promise<{ windowEnd: Date | null; backfillFrom: Date | null }> {
  const [row] = await db.execute<{ window_end: string | Date | null; backfill_from: string | Date | null }>(sql`
    insert into tiktok_sync_cursors (resource, last_run_at) values ('orders', ${now.toISOString()}::timestamptz)
    on conflict (resource) do update set last_run_at = excluded.last_run_at, updated_at = now()
    returning window_end, backfill_from
  `);
  return { windowEnd: row?.window_end ? new Date(row.window_end) : null, backfillFrom: row?.backfill_from ? new Date(row.backfill_from) : null };
}

/** Forward only: a slice that ends before the stored cursor (the overlap) never moves it back. */
async function advanceOrdersCursor(db: Database, windowEnd: Date): Promise<void> {
  await db.execute(sql`
    update tiktok_sync_cursors set window_end = ${windowEnd.toISOString()}::timestamptz, updated_at = now()
    where resource = 'orders' and (window_end is null or window_end < ${windowEnd.toISOString()}::timestamptz)
  `);
}

async function pollOrders(session: Session, summary: TikTokSyncSummary): Promise<void> {
  const cursor = await readOrdersCursor(session.db, session.clock());
  summary.poll.windowEnd = cursor.windowEnd?.toISOString() ?? null;
  const windows = planTikTokPollWindows(cursor, session.clock());
  summary.poll.slices = windows.length;
  // An order already stored in this run is not fetched again (pages overlap at their boundaries,
  // and slices overlap the previous run); a newer version is found by the next run's overlap.
  const done = new Set<string>();
  for (const window of windows) {
    // Every id of the slice must be stored before the cursor may pass it (§8.3): an order listed
    // but missing, unusable or not storable holds the cursor, and the run reports it.
    const sliceProblems = new Map<string, TikTokOrderProblem>();
    let pageToken: string | null = null;
    const seenTokens = new Set<string>();
    for (let page = 1; ; page += 1) {
      if (!budgetLeft(session)) throw budgetError("/order/search");
      const result = await searchTikTokOrders(session.deps.api, { updateTimeGe: window.start, updateTimeLt: window.end, pageToken, ...shopCall(session, "/order/search") });
      summary.poll.pages += 1;
      session.counts.invalid += result.invalidIds;
      if (result.invalidIds > 0) sliceProblems.set(`search:${window.start.toISOString()}`, "order_invalid");
      const fresh = result.orderIds.filter((id) => !done.has(id));
      summary.poll.orderIds += fresh.length;
      const outcome = newOutcome();
      try {
        await syncTikTokOrdersById(session, fresh, "poll", outcome);
      } finally {
        for (const id of outcome.stored) done.add(id);
        for (const [id, problem] of outcome.problems) sliceProblems.set(id, problem);
      }
      if (!result.nextPageToken) break;
      if (seenTokens.has(result.nextPageToken) || page >= TIKTOK_MAX_PAGES_PER_SLICE) {
        throw new TikTokApiError({ kind: "invalid_response", path: "/order/search", httpStatus: null, code: null, requestId: null });
      }
      seenTokens.add(result.nextPageToken);
      pageToken = result.nextPageToken;
    }
    if (sliceProblems.size > 0) {
      summary.problems.push(...problemSample(sliceProblems));
      throw new SyncIncomplete([...sliceProblems.values()][0]!);
    }
    await advanceOrdersCursor(session.db, window.end);
    summary.poll.slicesDone += 1;
    summary.poll.windowEnd = window.end.toISOString();
  }
  summary.poll.caughtUp = true;
}

// ---- Health on the connection and the cursor -------------------------------------------------

/** Best effort, like T3's "last webhook": a row a token refresh holds is skipped, never waited for. */
async function recordHealth(db: Database, now: Date, outcome: { ok: true } | { ok: false; code: string }, pollTouched: boolean): Promise<void> {
  const time = now.toISOString();
  if (pollTouched) {
    await db.execute(
      outcome.ok
        ? sql`update tiktok_sync_cursors set last_ok_at = ${time}::timestamptz, last_error_code = null, updated_at = now() where resource = 'orders'`
        : sql`update tiktok_sync_cursors set last_error_code = ${outcome.code.slice(0, 64)}, updated_at = now() where resource = 'orders'`,
    );
  }
  await db.execute(
    outcome.ok
      ? sql`update tiktok_shop_connections set last_poll_ok_at = ${time}::timestamptz where id in (select id from tiktok_shop_connections where status = 'active' for update skip locked)`
      : sql`update tiktok_shop_connections set last_error_code = ${outcome.code.slice(0, 64)}, last_error_at = ${time}::timestamptz where id in (select id from tiktok_shop_connections where status = 'active' for update skip locked)`,
  );
}

// ---- Entry points -----------------------------------------------------------------------------

/** One sync run. The caller holds the cron lock (withExclusiveRun). Throws only for a database or
 * programming failure; a TikTok failure stops the run and is reported in `error`. */
export async function runTikTokSync(db: Database, deps: TikTokSyncDeps, options: { budgetMs?: number } = {}): Promise<TikTokSyncSummary> {
  const clock = deps.now ?? (() => new Date());
  const deadline = clock().getTime() + (options.budgetMs ?? TIKTOK_SYNC_BUDGET_MS);
  const summary = emptySummary();

  // 1. Topics 6/7 first: a deauthorization stops this very run.
  const connectionEvents = await processDueTikTokConnectionEvents(db, { now: clock() });
  for (const outcome of connectionEvents ?? []) {
    if (outcome.kind === "processed") summary.connectionEvents.processed += 1;
    else if (outcome.kind !== "not_pending") summary.connectionEvents.notApplied += 1;
  }

  // 2. Token refresh when due.
  const refresh = await refreshTikTokToken(db, { auth: deps.auth, keyring: deps.keyring, now: clock });
  summary.tokenRefresh = refresh.kind === "failed" ? `failed:${refresh.errorCode}` : refresh.kind;

  const session = await openSession(db, deps, clock, deadline, summary.orders);
  if (typeof session === "string") {
    summary.connection = session;
    return summary;
  }
  summary.connection = "active";

  let pollTouched = false;
  try {
    // 3. Inbox, with at most half the budget, so a burst of webhooks never starves the poll.
    const fullDeadline = session.deadline;
    session.deadline = Math.min(fullDeadline, clock().getTime() + Math.floor((options.budgetMs ?? TIKTOK_SYNC_BUDGET_MS) / 2));
    try {
      await drainOrderEvents(session, summary, { limit: TIKTOK_INBOX_BATCH });
    } catch (error) {
      if (!(error instanceof TikTokApiError && error.kind === "budget_exhausted")) throw error;
      summary.budgetExhausted = true;
    } finally {
      session.deadline = fullDeadline;
    }
    // 4. The poll.
    pollTouched = true;
    await pollOrders(session, summary);
    await recordHealth(db, clock(), summary.budgetExhausted ? { ok: false, code: "budget_exhausted" } : { ok: true }, pollTouched);
  } catch (error) {
    if (error instanceof SyncIncomplete) {
      summary.error = { kind: "incomplete", code: error.code };
      await recordHealth(db, clock(), { ok: false, code: error.code }, pollTouched);
      return summary;
    }
    if (!(error instanceof TikTokApiError)) throw error;
    if (error.kind === "budget_exhausted") {
      // Behind, not failing: the next run carries on. Shown as the cursor's last code.
      summary.budgetExhausted = true;
      await recordHealth(db, clock(), { ok: false, code: "budget_exhausted" }, pollTouched);
      return summary;
    }
    summary.error = { kind: error.kind, code: tiktokErrorCode(error) };
    await recordHealth(db, clock(), { ok: false, code: summary.error.code }, pollTouched);
  }
  return summary;
}

export type DrainTikTokWebhookEventResult =
  | { kind: "processed" | "not_due" | "not_connected" | "reauth_required" | "budget_exhausted" }
  /** The order was not stored (missing, unusable, not storable); the event's retry is scheduled. */
  | { kind: "not_stored"; problems: { id: string; problem: TikTokOrderProblem }[] }
  | { kind: "error"; error: { kind: TikTokErrorKind; code: string } };

/** The webhook route's `after()`: re-fetches the one order this event names (read only). Not under
 * the cron lock: the store is serialized per order and idempotent, and the event's claim keeps the
 * cron from fetching it at the same time. */
export async function drainTikTokWebhookOrderEvent(db: Database, deps: TikTokSyncDeps, eventId: string, options: { budgetMs?: number } = {}): Promise<DrainTikTokWebhookEventResult> {
  const clock = deps.now ?? (() => new Date());
  const summary = emptySummary();
  const session = await openSession(db, deps, clock, clock().getTime() + (options.budgetMs ?? TIKTOK_WEBHOOK_DRAIN_BUDGET_MS), summary.orders);
  if (typeof session === "string") return { kind: session };
  try {
    await drainOrderEvents(session, summary, { eventId, limit: 1 });
  } catch (error) {
    if (!(error instanceof TikTokApiError)) throw error;
    if (error.kind === "budget_exhausted") return { kind: "budget_exhausted" };
    return { kind: "error", error: { kind: error.kind, code: tiktokErrorCode(error) } };
  }
  if (summary.inbox.claimed === 0) return { kind: "not_due" };
  return summary.inbox.retried + summary.inbox.failed > 0 ? { kind: "not_stored", problems: summary.problems } : { kind: "processed" };
}
