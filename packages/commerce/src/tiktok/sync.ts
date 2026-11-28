import "server-only";
import { sql } from "drizzle-orm";
import {
  ORDER_DETAIL_MAX_IDS,
  Secret,
  TikTokApiError,
  getTikTokOrderDetails,
  getTikTokOrderTransactions,
  getTikTokPayments,
  getTikTokStatementTransactions,
  getTikTokStatements,
  getTikTokUnsettledTransactions,
  getTikTokWarehouses,
  ownTikTokWarehouseIds,
  searchTikTokProducts,
  type TikTokStatementProjection,
  type TikTokStatementTransactionProjection,
  SEARCH_AFTER_SALES_MAX_ORDER_IDS,
  isTikTokOrderId,
  searchTikTokAfterSales,
  searchTikTokOrders,
  type TikTokAfterSaleKind,
  type TikTokAfterSaleProjection,
  type TikTokAuthClient,
  type TikTokClient,
  type TikTokErrorKind,
  type TokenKeyring,
} from "@ammari/tiktok-shop";
import type { TikTokBackfillState, TikTokSnapshotSource } from "@ammari/db/schema";
import type { Database } from "../db";
import { getTikTokConnectionView, loadTikTokCredentials, refreshTikTokToken, tiktokErrorCode } from "./connection";
import { applyTikTokAfterSale, ingestTikTokAfterSale, listTikTokAfterSalesToApply, type ApplyTikTokAfterSaleResult } from "./after-sale";
import { applyTikTokOrder, listTikTokOrdersToApply, tiktokOrdersApplyEnabled, type ApplyTikTokOrderResult } from "./apply";
import {
  listTikTokOrderFeesToRebuild,
  listTikTokOrdersWithPendingFees,
  rebuildTikTokOrderFees,
  storeTikTokOrderTransactions,
  storeTikTokPayout,
  storeTikTokStatement,
  storeTikTokStatementTransactions,
  storeTikTokUnsettledTransaction,
} from "./finance";
import { TIKTOK_FINANCE_REOPEN_MAX_MS, TIKTOK_FINANCE_SLICE_MS, planTikTokFinanceWindows } from "./finance-windows";
import { advanceTikTokBackfill, loadFetchingTikTokBackfill, markTikTokBackfillFetched, recordTikTokBackfillRun, setTikTokBackfillSlice, type TikTokBackfillResource, type TikTokBackfillView } from "./backfill";
import { nextTikTokBackfillSliceSeconds, planTikTokBackfillWindows } from "./backfill-windows";
import { ingestTikTokOrder } from "./order-store";
import { finishTikTokListingPass, storeTikTokListingProduct } from "./stock-sync";
import { TIKTOK_STOCK_REREAD_CODES } from "./stock-push-rules";
import { drainTikTokStockOutbox, emptyTikTokStockPushCounts, prepareTikTokStockOutbox, queueTikTokListingDrift, tiktokStockPushDue, tiktokStockPushGate, type TikTokStockPushContext, type TikTokStockPushCounts } from "./stock-push";
import { TIKTOK_POLL_LAG_MS, TIKTOK_POLL_SLICE_MS, planTikTokPollWindows, type TikTokPollWindow } from "./order-windows";
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
// T5 (docs/plans/tiktok-shop-integration.md §4, §9 step 3): when the kill switch
// `tiktok_shop_connections.orders_apply_enabled` is on, every stored order is applied to admin orders
// and stock (apply.ts), and each run first re-checks the orders not applied yet: held ones (a SKU
// mapped or stock recorded since), newer versions, and applied orders waiting at the packing gate
// (an hour passing fires no webhook). While it is off the run stays T4's dry run. An apply that is
// held or busy never blocks the cursor: the re-check picks it up on every run.
// T6 (docs/plans/tiktok-shop-integration.md §4.5, §9 step 5): Search Returns and Search Cancellations
// (read only, Q15), polled by `update_time` windows on their own cursors (`returns`, `cancellations`)
// and fetched by order id when topic 12 / 11 arrives. Each request's order is fetched first (its
// status path may cancel it), then the request is stored (after-sale.ts) and, with the kill switch
// on, applied. The re-check retries requests not applied yet and clears a passed response deadline.
// T7 (docs/plans/tiktok-shop-integration.md §3.5, §5.3, §9 step 6): finance, read only, at most every
// 30 minutes (the cron runs every 5, "every 6th run") and only when `seller.finance.info` was granted:
// Get Unsettled Transactions (estimates), Get Statements by `statement_time` + Get Transactions by
// Statement (actuals, Σ = settlement), Get Transactions by Order for SKU-level fees, Get Payments, each
// on its own cursor (`unsettled`, `statements`, `payments`), then order_channel_fees rebuilt for every
// order touched (finance.ts). No posting rule or journal (T8). Nothing here logs: the route logs the
// summary (codes only, never a body or a token).
// T9 (docs/plans/tiktok-shop-integration.md §9.6): a backfill in `fetching` is read last, in what is left
// of the budget, so packing and the live poll never wait for history: orders, returns and
// cancellations by `update_time` slices, statements and payouts by their time, each resuming at its
// last finished slice (`tiktok_backfills.*_done_until`). Orders are stored with source `backfill`; one
// the backfill is the first to store is not applied until the owner confirms the backfill (apply.ts).
// An order slice that does not finish within a run is halved for the next run (T4's known limit).
// Stock sync S1 (docs/plans/tiktok-stock-sync.md §4): every 15 minutes, after finance and before the
// backfill, with at most a quarter of the budget, the listing read pass: Get Warehouse List, then every
// page of Search Products, each product stored (tiktok_listing_skus) with its classification and the
// exact auto-map. Only a complete pass marks unseen SKUs `not_listed`.
// Stock sync S2 (docs/plans/tiktok-stock-sync.md §7): right after the read pass, with at most a quarter of
// the budget, the push's drain (stock-push.ts): hold expiries queued, the hourly full reconciliation,
// then every due dirty variant pushed (one Update Inventory call per product) while the stock switch is
// on; a failed push is retried here with backoff. The same drain runs right after a stock change
// (pushTikTokStockNow, from the apps' after()).

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

export interface TikTokApplyCounts {
  /** Whether the kill switch was on for this run. */
  enabled: boolean;
  created: number;
  updated: number;
  unchanged: number;
  held: number;
  skipped: number;
  busy: number;
  /** A database or programming failure on one order (the others go on). */
  failed: number;
  /** Orders the re-check step looked at. */
  rechecked: number;
  /** The re-check ran out of its share of the budget, or more orders were due than one run takes;
   * the rest waits for the next run. */
  recheckIncomplete: boolean;
  /** Projection gone between store and apply (should never happen). */
  notFound: number;
  /** T9: stored first by a backfill that is not confirmed yet (left alone until "Terapkan riwayat"). */
  waitingBackfill: number;
  /** Up to 20 orders that failed (error class or SQLSTATE) or were busy (lock timeout, deadlock, an
   * order moved under the lock), so a repeating one can be named. Codes only, never values. */
  problems: { id: string; kind: "failed" | "busy" | "not_found"; code: string }[];
}

export interface TikTokAfterSaleCounts {
  /** Per resource: slices planned and done, pages, and whether the poll caught up. */
  poll: Record<TikTokAfterSaleKind, { slices: number; slicesDone: number; pages: number; caughtUp: boolean; windowEnd: string | null }>;
  /** Requests TikTok returned and stored. */
  fetched: number;
  snapshotsInserted: number;
  replays: number;
  conflicts: number;
  /** Requests (or search entries) without a usable id, order id, status or update_time. */
  invalid: number;
  storeFailed: number;
  applied: number;
  unchanged: number;
  refundsRecorded: number;
  busy: number;
  failed: number;
  notFound: number;
  rechecked: number;
  recheckIncomplete: boolean;
  /** Up to 20 requests that failed or were busy: `kind:id` and a code, never content. */
  problems: { id: string; kind: "failed" | "busy" | "not_found" | "store_failed" | "invalid"; code: string }[];
}

export interface TikTokFinanceCounts {
  /** Why finance did not run this time; null when it ran. */
  skipped: "not_due" | "no_scope" | null;
  unsettled: number;
  statements: number;
  statementTransactions: number;
  /** Statements whose transactions do not add up or cannot be read (visible, re-checked). */
  statementsHeld: number;
  orderFetches: number;
  /** Order transactions whose SKU lines did not add up or could not be read. */
  orderFeesHeld: number;
  /** Settled order transactions TikTok did not return in Get Transactions by Order (still pending). */
  orderFeesMissing: number;
  payouts: number;
  /** order_channel_fees rebuilds: written (changed), unchanged, held, waiting for the admin order. */
  feesWritten: number;
  feesUnchanged: number;
  feesHeld: number;
  feesWaiting: number;
  busy: number;
  failed: number;
  /** Records without a usable id or type, statement or order fetches that failed: ids and codes only. */
  invalid: number;
  problems: { id: string; kind: "invalid" | "busy" | "failed" | "store_failed"; code: string }[];
}

export interface TikTokListingCounts {
  /** Why the read pass did not run this time; null when it ran. */
  skipped: "not_due" | "no_scope" | null;
  /** Every page was read and stored (only then are unseen SKUs marked `not_listed`). */
  complete: boolean;
  /** What stopped an incomplete pass: `budget_exhausted`, `listings_invalid`, a TikTok code. */
  stoppedBy: string | null;
  pages: number;
  products: number;
  skus: number;
  autoMapped: number;
  /** Product, SKU or warehouse entries without a usable id (the pass is then incomplete). */
  invalid: number;
  ownWarehouses: number;
  notListed: number;
  severalListings: number;
  /** S2: variants re-queued because TikTok showed another quantity than the one last pushed. */
  drift: number;
}

export interface TikTokBackfillCounts {
  /** A backfill was being read and this run worked on it. */
  ran: boolean;
  id: string | null;
  /** Its state after this run (`fetched` once everything is read); null when there is none. */
  state: TikTokBackfillState | null;
  orders: { slices: number; pages: number; stored: number; sliceSeconds: number | null };
  afterSales: { slices: number; pages: number };
  finance: { windows: number; skipped: "no_scope" | null };
  /** What stopped it this run (a TikTok error code, `budget_exhausted`, or an incomplete slice). */
  stoppedBy: string | null;
}

export interface TikTokSyncSummary {
  connection: "active" | "not_connected" | "reauth_required";
  connectionEvents: { processed: number; notApplied: number };
  tokenRefresh: string | null;
  inbox: { claimed: number; processed: number; ignored: number; retried: number; failed: number; released: number };
  poll: { slices: number; slicesDone: number; pages: number; orderIds: number; caughtUp: boolean; windowEnd: string | null };
  orders: TikTokOrderCounts;
  apply: TikTokApplyCounts;
  afterSales: TikTokAfterSaleCounts;
  finance: TikTokFinanceCounts;
  listings: TikTokListingCounts;
  /** Stock sync S2: the push's drain. */
  stockPush: TikTokStockPushCounts;
  backfill: TikTokBackfillCounts;
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

function emptyApplyCounts(): TikTokApplyCounts {
  return { enabled: false, created: 0, updated: 0, unchanged: 0, held: 0, skipped: 0, busy: 0, failed: 0, rechecked: 0, recheckIncomplete: false, notFound: 0, waitingBackfill: 0, problems: [] };
}

function emptyAfterSaleCounts(): TikTokAfterSaleCounts {
  const poll = () => ({ slices: 0, slicesDone: 0, pages: 0, caughtUp: false, windowEnd: null });
  return { poll: { return: poll(), cancellation: poll() }, fetched: 0, snapshotsInserted: 0, replays: 0, conflicts: 0, invalid: 0, storeFailed: 0, applied: 0, unchanged: 0, refundsRecorded: 0, busy: 0, failed: 0, notFound: 0, rechecked: 0, recheckIncomplete: false, problems: [] };
}

function emptyFinanceCounts(): TikTokFinanceCounts {
  return { skipped: "not_due", unsettled: 0, statements: 0, statementTransactions: 0, statementsHeld: 0, orderFetches: 0, orderFeesHeld: 0, orderFeesMissing: 0, payouts: 0, feesWritten: 0, feesUnchanged: 0, feesHeld: 0, feesWaiting: 0, busy: 0, failed: 0, invalid: 0, problems: [] };
}

function emptySummary(): TikTokSyncSummary {
  return {
    connection: "not_connected",
    connectionEvents: { processed: 0, notApplied: 0 },
    tokenRefresh: null,
    inbox: { claimed: 0, processed: 0, ignored: 0, retried: 0, failed: 0, released: 0 },
    poll: { slices: 0, slicesDone: 0, pages: 0, orderIds: 0, caughtUp: false, windowEnd: null },
    orders: emptyCounts(),
    apply: emptyApplyCounts(),
    afterSales: emptyAfterSaleCounts(),
    finance: emptyFinanceCounts(),
    listings: { skipped: "not_due", complete: false, stoppedBy: null, pages: 0, products: 0, skus: 0, autoMapped: 0, invalid: 0, ownWarehouses: 0, notListed: 0, severalListings: 0, drift: 0 },
    stockPush: emptyTikTokStockPushCounts(),
    backfill: { ran: false, id: null, state: null, orders: { slices: 0, pages: 0, stored: 0, sliceSeconds: null }, afterSales: { slices: 0, pages: 0 }, finance: { windows: 0, skipped: null }, stoppedBy: null },
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
  connectionId: string;
  shopCipher: string;
  accessToken: Secret;
  tokenGeneration: number;
  counts: TikTokOrderCounts;
  apply: TikTokApplyCounts;
  afterSales: TikTokAfterSaleCounts;
  /** Orders stored by this run (fetched again only by the next run). */
  storedOrders: Set<string>;
  /** T9: set while the backfill step runs; orders it stores first carry it (the gate). */
  backfillId: string | null;
}

async function openSession(db: Database, deps: TikTokSyncDeps, clock: () => Date, deadline: number, summary: TikTokSyncSummary): Promise<Session | "not_connected" | "reauth_required"> {
  const { orders: counts, apply, afterSales } = summary;
  const credentials = await loadTikTokCredentials(db, deps.keyring, clock());
  if (!credentials.ok) {
    if (credentials.reason === "reauth_required") return "reauth_required";
    const view = await getTikTokConnectionView(db);
    return view?.status === "reauth_required" ? "reauth_required" : "not_connected";
  }
  const { connectionId, shopCipher, accessToken, tokenGeneration } = credentials.credentials;
  apply.enabled = await tiktokOrdersApplyEnabled(db);
  return { db, deps, clock, deadline, connectionId, shopCipher, accessToken, tokenGeneration, counts, apply, afterSales, storedOrders: new Set(), backfillId: null };
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
        const result = await ingestTikTokOrder(session.db, order, source, session.clock(), { backfillId: session.backfillId });
        outcome.stored.add(order.tiktokOrderId);
        session.storedOrders.add(order.tiktokOrderId);
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
        continue;
      }
      await applyStored(session, order.tiktokOrderId, source);
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

const APPLY_PROBLEM_SAMPLE = 20;

function noteApplyProblem(apply: TikTokApplyCounts, problem: TikTokApplyCounts["problems"][number]): void {
  if (apply.problems.length < APPLY_PROBLEM_SAMPLE) apply.problems.push(problem);
}

/** A database error's SQLSTATE, else the error class: enough to tell one failure from another
 * without any message text (a driver message can quote values). */
function applyErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return `sqlstate:${code}`;
  return error instanceof Error ? error.name.slice(0, 40) : "unknown";
}

function countApply(apply: TikTokApplyCounts, tiktokOrderId: string, result: ApplyTikTokOrderResult): void {
  switch (result.kind) {
    case "created":
      apply.created += 1;
      break;
    case "updated":
      apply.updated += 1;
      break;
    case "unchanged":
      apply.unchanged += 1;
      break;
    case "not_found":
      apply.notFound += 1;
      noteApplyProblem(apply, { id: tiktokOrderId, kind: "not_found", code: "not_found" });
      break;
    case "held":
      apply.held += 1;
      break;
    case "skipped":
      apply.skipped += 1;
      break;
    case "busy":
      apply.busy += 1;
      noteApplyProblem(apply, { id: tiktokOrderId, kind: "busy", code: result.code });
      break;
    case "waiting_backfill":
      apply.waitingBackfill += 1;
      break;
  }
}

/** Applies one stored order when the kill switch is on. A failure is counted, never thrown: the
 * order is stored, and the re-check step retries it on the next run. */
async function applyStored(session: Session, tiktokOrderId: string, source: TikTokSnapshotSource | "recheck"): Promise<void> {
  if (!session.apply.enabled) return;
  try {
    countApply(session.apply, tiktokOrderId, await applyTikTokOrder(session.db, tiktokOrderId, { now: session.clock(), source }));
  } catch (error) {
    // The message is dropped like a store failure's (a driver message can quote values); the order
    // id and the code are kept, so the route's ERROR line names it. Retried on the next run.
    session.apply.failed += 1;
    noteApplyProblem(session.apply, { id: tiktokOrderId, kind: "failed", code: applyErrorCode(error) });
  }
}

/** Plan §9 step 3: held orders, newer versions not applied yet, and orders waiting at the packing
 * gate. No TikTok call: only what is stored. Stops at the run's budget. */
async function recheckStoredOrders(session: Session, budgetMs: number): Promise<void> {
  if (!session.apply.enabled) return;
  // At most a quarter of the run, so the inbox and the poll always get their turn; the rest waits
  // for the next run.
  const until = Math.min(session.deadline, session.clock().getTime() + Math.floor(budgetMs / 4));
  const due = await listTikTokOrdersToApply(session.db, session.clock());
  if (due.truncated) session.apply.recheckIncomplete = true;
  for (const id of due.ids) {
    if (session.clock().getTime() >= until) {
      session.apply.recheckIncomplete = true;
      return;
    }
    session.apply.rechecked += 1;
    await applyStored(session, id, "recheck");
  }
}

/** Up to 20 problem ids for the summary (TikTok order ids, not buyer data). */
function problemSample(problems: Map<string, TikTokOrderProblem>): { id: string; problem: TikTokOrderProblem }[] {
  return [...problems].slice(0, 20).map(([id, problem]) => ({ id, problem }));
}

// ---- Inbox (topics 1, 11, 12) ---------------------------------------------------------------

type ClaimedEvent = {
  id: string;
  type: number;
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
    returning e.id, e.type, e.tiktok_order_id, e.attempts
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
    // Topics 11/12 (T6): the order's requests too. An event is settled only once both are stored; a
    // failure takes the order out of `stored`, so its event is retried (or released) like an order.
    // Every order still waiting for its requests is known up front: when a search throws, all of
    // them (either kind) leave `stored`, never only the chunk that failed.
    const pending = new Map<TikTokAfterSaleKind, string[]>();
    for (const kind of ["cancellation", "return"] as const) {
      const topic = kind === "return" ? TIKTOK_WEBHOOK_TOPICS.RETURN_STATUS_CHANGE : TIKTOK_WEBHOOK_TOPICS.CANCELLATION_STATUS_CHANGE;
      pending.set(kind, [...new Set(withOrder.filter((event) => event.type === topic && outcome.stored.has(event.tiktok_order_id!)).map((event) => event.tiktok_order_id!))]);
    }
    const unsettled = new Set([...pending.values()].flat());
    try {
      for (const [kind, ids] of pending) {
        for (let start = 0; start < ids.length; start += SEARCH_AFTER_SALES_MAX_ORDER_IDS) {
          const chunk = ids.slice(start, start + SEARCH_AFTER_SALES_MAX_ORDER_IDS);
          const problems = await syncAfterSalesForOrders(session, kind, chunk, "webhook");
          for (const [id, problem] of problems) {
            outcome.stored.delete(id);
            outcome.problems.set(id, problem);
          }
        }
      }
    } catch (error) {
      for (const id of unsettled) outcome.stored.delete(id);
      throw error;
    }
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
  constructor(readonly code: TikTokOrderProblem | "finance_invalid" | "listings_invalid") {
    super(`tiktok sync incomplete: ${code}`);
    this.name = "SyncIncomplete";
  }
}

type CursorResource = "orders" | "returns" | "cancellations" | "unsettled" | "statements" | "payments" | "products";

async function readOrdersCursor(db: Database, now: Date, resource: CursorResource = "orders"): Promise<{ windowEnd: Date | null; backfillFrom: Date | null }> {
  const [row] = await db.execute<{ window_end: string | Date | null; backfill_from: string | Date | null }>(sql`
    insert into tiktok_sync_cursors (resource, last_run_at) values (${resource}, ${now.toISOString()}::timestamptz)
    on conflict (resource) do update set last_run_at = excluded.last_run_at, updated_at = now()
    returning window_end, backfill_from
  `);
  return { windowEnd: row?.window_end ? new Date(row.window_end) : null, backfillFrom: row?.backfill_from ? new Date(row.backfill_from) : null };
}

/** Forward only: a slice that ends before the stored cursor (the overlap) never moves it back. */
async function advanceOrdersCursor(db: Database, windowEnd: Date, resource: CursorResource = "orders"): Promise<void> {
  await db.execute(sql`
    update tiktok_sync_cursors set window_end = ${windowEnd.toISOString()}::timestamptz, updated_at = now()
    where resource = ${resource} and (window_end is null or window_end < ${windowEnd.toISOString()}::timestamptz)
  `);
}

/** Every page of one order search window, storing every order listed (Get Order Detail). Returns the
 * ids that could not be stored; the caller holds its cursor when any. `done`: ids already stored in
 * this run (pages overlap at their boundaries). */
async function searchOrderWindow(session: Session, window: TikTokPollWindow, source: TikTokSnapshotSource, done: Set<string>, onPage: (fresh: number) => void): Promise<Map<string, TikTokOrderProblem>> {
  const sliceProblems = new Map<string, TikTokOrderProblem>();
  let pageToken: string | null = null;
  const seenTokens = new Set<string>();
  for (let page = 1; ; page += 1) {
    if (!budgetLeft(session)) throw budgetError("/order/search");
    const result = await searchTikTokOrders(session.deps.api, { updateTimeGe: window.start, updateTimeLt: window.end, pageToken, ...shopCall(session, "/order/search") });
    session.counts.invalid += result.invalidIds;
    if (result.invalidIds > 0) sliceProblems.set(`search:${window.start.toISOString()}`, "order_invalid");
    const fresh = result.orderIds.filter((id) => !done.has(id));
    onPage(fresh.length);
    const outcome = newOutcome();
    try {
      await syncTikTokOrdersById(session, fresh, source, outcome);
    } finally {
      for (const id of outcome.stored) done.add(id);
      for (const [id, problem] of outcome.problems) sliceProblems.set(id, problem);
    }
    if (!result.nextPageToken) return sliceProblems;
    if (seenTokens.has(result.nextPageToken) || page >= TIKTOK_MAX_PAGES_PER_SLICE) {
      throw new TikTokApiError({ kind: "invalid_response", path: "/order/search", httpStatus: null, code: null, requestId: null });
    }
    seenTokens.add(result.nextPageToken);
    pageToken = result.nextPageToken;
  }
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
    const sliceProblems = await searchOrderWindow(session, window, "poll", done, (fresh) => {
      summary.poll.pages += 1;
      summary.poll.orderIds += fresh;
    });
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

// ---- Returns and cancellations (T6) ------------------------------------------------------------

const RESOURCE_OF: Record<TikTokAfterSaleKind, CursorResource> = { return: "returns", cancellation: "cancellations" };

function noteAfterSaleProblem(counts: TikTokAfterSaleCounts, problem: TikTokAfterSaleCounts["problems"][number]): void {
  if (counts.problems.length < APPLY_PROBLEM_SAMPLE) counts.problems.push(problem);
}

function countAfterSale(counts: TikTokAfterSaleCounts, id: string, result: ApplyTikTokAfterSaleResult): void {
  if (result.kind === "applied") {
    counts.applied += 1;
    if (result.refundRecorded) counts.refundsRecorded += 1;
  } else if (result.kind === "unchanged") counts.unchanged += 1;
  else if (result.kind === "busy") {
    counts.busy += 1;
    noteAfterSaleProblem(counts, { id, kind: "busy", code: result.code });
  } else {
    counts.notFound += 1;
    noteAfterSaleProblem(counts, { id, kind: "not_found", code: "not_found" });
  }
}

/** Applies one stored request when the kill switch is on. A failure is counted, never thrown: the
 * request is stored, and the re-check retries it on the next run. */
async function applyAfterSaleStored(session: Session, kind: TikTokAfterSaleKind, requestId: string, source: TikTokSnapshotSource | "recheck"): Promise<void> {
  if (!session.apply.enabled) return;
  try {
    countAfterSale(session.afterSales, `${kind}:${requestId}`, await applyTikTokAfterSale(session.db, kind, requestId, { now: session.clock(), source }));
  } catch (error) {
    session.afterSales.failed += 1;
    noteAfterSaleProblem(session.afterSales, { id: `${kind}:${requestId}`, kind: "failed", code: applyErrorCode(error) });
  }
}

/** Stores (and applies) requests TikTok returned, after fetching their orders that this run has not
 * stored yet, so a cancellation or refund meets the order's newest status. Returns the TikTok order
 * ids whose order or request could not be stored (the caller holds its cursor or retries the event). */
async function storeAfterSales(session: Session, records: readonly TikTokAfterSaleProjection[], source: TikTokSnapshotSource): Promise<Map<string, TikTokOrderProblem>> {
  const failed = new Map<string, TikTokOrderProblem>();
  const orderIds = [...new Set(records.map((record) => record.tiktokOrderId))].filter((id) => !session.storedOrders.has(id));
  if (orderIds.length > 0) {
    const outcome = newOutcome();
    await syncTikTokOrdersById(session, orderIds, source, outcome);
    // An order TikTok did not return is not a reason to drop its request: the request is still
    // stored (it waits for the order), but the slice is held so the next run tries again.
    for (const [id, problem] of outcome.problems) failed.set(id, problem);
  }
  for (const record of records) {
    try {
      const result = await ingestTikTokAfterSale(session.db, record, source, session.clock());
      if (result.snapshot === "order_mismatch") {
        // TikTok named another order for a request already stored: never re-pointed silently. The
        // slice is held and the request named, so a person looks.
        session.afterSales.conflicts += 1;
        noteAfterSaleProblem(session.afterSales, { id: `${record.kind}:${record.requestId}`, kind: "invalid", code: "order_mismatch" });
        failed.set(record.tiktokOrderId, "order_invalid");
        continue;
      }
      session.afterSales.fetched += 1;
      if (result.snapshot === "inserted") session.afterSales.snapshotsInserted += 1;
      else if (result.snapshot === "replay") session.afterSales.replays += 1;
      else session.afterSales.conflicts += 1;
    } catch (error) {
      // The message is dropped (a driver message can quote the payload); the id and the code are kept.
      session.afterSales.storeFailed += 1;
      noteAfterSaleProblem(session.afterSales, { id: `${record.kind}:${record.requestId}`, kind: "store_failed", code: applyErrorCode(error) });
      failed.set(record.tiktokOrderId, "store_failed");
      continue;
    }
    await applyAfterSaleStored(session, record.kind, record.requestId, source);
  }
  return failed;
}

/** A topic 11/12 trigger: every request of these orders (up to 20 ids), every page. */
async function syncAfterSalesForOrders(session: Session, kind: TikTokAfterSaleKind, orderIds: readonly string[], source: TikTokSnapshotSource): Promise<Map<string, TikTokOrderProblem>> {
  const failed = new Map<string, TikTokOrderProblem>();
  let pageToken: string | null = null;
  const seenTokens = new Set<string>();
  for (let page = 1; ; page += 1) {
    if (!budgetLeft(session)) throw budgetError("/return_refund/search");
    const result = await searchTikTokAfterSales(session.deps.api, kind, { orderIds, pageToken, ...shopCall(session, "/return_refund/search") });
    session.afterSales.invalid += result.invalid;
    // An entry that cannot be versioned cannot be pinned to one order (its order id may be what is
    // broken): every order of this search is retried with that reason, never settled as done.
    if (result.invalid > 0) {
      for (const id of orderIds) failed.set(id, "order_invalid");
      noteAfterSaleProblem(session.afterSales, { id: `${kind}:${result.invalidIds[0] ?? "search"}`, kind: "invalid", code: "invalid_record" });
    }
    for (const [id, problem] of await storeAfterSales(session, result.records, source)) if (!failed.has(id)) failed.set(id, problem);
    if (!result.nextPageToken) return failed;
    if (seenTokens.has(result.nextPageToken) || page >= TIKTOK_MAX_PAGES_PER_SLICE) {
      throw new TikTokApiError({ kind: "invalid_response", path: "/return_refund/search", httpStatus: null, code: null, requestId: null });
    }
    seenTokens.add(result.nextPageToken);
    pageToken = result.nextPageToken;
  }
}

/** Every page of one returns / cancellations search window, storing every request (and its order).
 * Returns the TikTok order ids whose request or order could not be stored. */
async function searchAfterSaleWindow(session: Session, summary: TikTokSyncSummary, kind: TikTokAfterSaleKind, window: TikTokPollWindow, source: TikTokSnapshotSource, onPage: () => void): Promise<Map<string, TikTokOrderProblem>> {
  const sliceProblems = new Map<string, TikTokOrderProblem>();
  let pageToken: string | null = null;
  const seenTokens = new Set<string>();
  for (let page = 1; ; page += 1) {
    if (!budgetLeft(session)) throw budgetError("/return_refund/search");
    const result = await searchTikTokAfterSales(session.deps.api, kind, { updateTimeGe: window.start, updateTimeLt: window.end, pageToken, ...shopCall(session, "/return_refund/search") });
    onPage();
    summary.afterSales.invalid += result.invalid;
    if (result.invalid > 0) {
      sliceProblems.set(`${kind}:${result.invalidIds[0] ?? window.start.toISOString()}`, "order_invalid");
      noteAfterSaleProblem(summary.afterSales, { id: `${kind}:${result.invalidIds[0] ?? "search"}`, kind: "invalid", code: "invalid_record" });
    }
    for (const [id, problem] of await storeAfterSales(session, result.records, source)) sliceProblems.set(id, problem);
    if (!result.nextPageToken) return sliceProblems;
    if (seenTokens.has(result.nextPageToken) || page >= TIKTOK_MAX_PAGES_PER_SLICE) {
      throw new TikTokApiError({ kind: "invalid_response", path: "/return_refund/search", httpStatus: null, code: null, requestId: null });
    }
    seenTokens.add(result.nextPageToken);
    pageToken = result.nextPageToken;
  }
}

/** The reconciliation poll for one kind (plan §9 step 5): the same window mechanics as orders
 * (order-windows.ts), on its own cursor. A slice whose requests or orders could not all be stored
 * holds the cursor (`incomplete`); the next run repeats it, and storing is idempotent. */
async function pollAfterSales(session: Session, summary: TikTokSyncSummary, kind: TikTokAfterSaleKind): Promise<void> {
  const resource = RESOURCE_OF[kind];
  const poll = summary.afterSales.poll[kind];
  const cursor = await readOrdersCursor(session.db, session.clock(), resource);
  poll.windowEnd = cursor.windowEnd?.toISOString() ?? null;
  const windows = planTikTokPollWindows(cursor, session.clock());
  poll.slices = windows.length;
  for (const window of windows) {
    const sliceProblems = await searchAfterSaleWindow(session, summary, kind, window, "poll", () => {
      poll.pages += 1;
    });
    if (sliceProblems.size > 0) {
      summary.problems.push(...problemSample(sliceProblems));
      throw new SyncIncomplete([...sliceProblems.values()][0]!);
    }
    await advanceOrdersCursor(session.db, window.end, resource);
    poll.slicesDone += 1;
    poll.windowEnd = window.end.toISOString();
  }
  poll.caughtUp = true;
}

/** Requests stored and not applied yet, waiting for their order, or past their response deadline
 * (no TikTok call). At most a quarter of the run. */
async function recheckStoredAfterSales(session: Session, budgetMs: number): Promise<void> {
  if (!session.apply.enabled) return;
  const until = Math.min(session.deadline, session.clock().getTime() + Math.floor(budgetMs / 4));
  const due = await listTikTokAfterSalesToApply(session.db, session.clock());
  if (due.truncated) session.afterSales.recheckIncomplete = true;
  for (const item of due.items) {
    if (session.clock().getTime() >= until) {
      session.afterSales.recheckIncomplete = true;
      return;
    }
    session.afterSales.rechecked += 1;
    await applyAfterSaleStored(session, item.kind, item.requestId, "recheck");
  }
}

// ---- Finance (T7) ---------------------------------------------------------------------------

/** Finance runs at most every 30 minutes (plan §9 step 6: every 6th run of the 5-minute cron). */
export const TIKTOK_FINANCE_EVERY_MS = 30 * 60_000;
/** Unsettled transactions are a current list; it is read over this span of order creation time. */
export const TIKTOK_UNSETTLED_LOOKBACK_MS = 90 * 86_400_000;
export const TIKTOK_FINANCE_SCOPE = "seller.finance.info";
/** Order fee fetches (one TikTok call per order) per run. */
export const TIKTOK_ORDER_FEE_FETCHES_PER_RUN = 100;

function noteFinanceProblem(counts: TikTokFinanceCounts, problem: TikTokFinanceCounts["problems"][number]): void {
  if (counts.problems.length < APPLY_PROBLEM_SAMPLE) counts.problems.push(problem);
}

async function financeSkip(session: Session): Promise<TikTokFinanceCounts["skipped"]> {
  const view = await getTikTokConnectionView(session.db);
  // Without the finance scope every call would fail (plan §11): M2/M3 then stay manual, visibly.
  if (!view?.grantedScopes.includes(TIKTOK_FINANCE_SCOPE)) return "no_scope";
  const [row] = await session.db.execute<{ last_run_at: string | Date | null }>(sql`select last_run_at from tiktok_sync_cursors where resource = 'statements'`);
  const lastRun = row?.last_run_at ? new Date(row.last_run_at).getTime() : null;
  return lastRun !== null && session.clock().getTime() - lastRun < TIKTOK_FINANCE_EVERY_MS ? "not_due" : null;
}

/** Every page of one finance list, stopping on a repeated token like the other polls. */
async function eachPage<T>(session: Session, path: string, fetchPage: (pageToken: string | null) => Promise<{ records: T[]; invalid: number; invalidIds: string[]; nextPageToken: string | null }>, onPage: (page: { records: T[]; invalid: number; invalidIds: string[] }) => Promise<void>): Promise<void> {
  let pageToken: string | null = null;
  const seenTokens = new Set<string>();
  for (let page = 1; ; page += 1) {
    if (!budgetLeft(session)) throw budgetError(path);
    const result = await fetchPage(pageToken);
    await onPage(result);
    if (!result.nextPageToken) return;
    if (seenTokens.has(result.nextPageToken) || page >= TIKTOK_MAX_PAGES_PER_SLICE) throw new TikTokApiError({ kind: "invalid_response", path, httpStatus: null, code: null, requestId: null });
    seenTokens.add(result.nextPageToken);
    pageToken = result.nextPageToken;
  }
}

/** Get Unsettled Transactions over the last 90 days of order creation: estimates (Q9). An entry
 * without an id or type holds the cursor (`incomplete`); the rest is stored. */
async function pollUnsettled(session: Session, summary: TikTokSyncSummary, touched: Set<string>): Promise<void> {
  const counts = summary.finance;
  await readOrdersCursor(session.db, session.clock(), "unsettled");
  const to = new Date(Math.floor((session.clock().getTime() - TIKTOK_POLL_LAG_MS) / 1000) * 1000);
  const from = new Date(to.getTime() - TIKTOK_UNSETTLED_LOOKBACK_MS);
  let invalid = 0;
  await eachPage(
    session,
    "/finance/unsettled",
    (pageToken) => getTikTokUnsettledTransactions(session.deps.api, { from, to, pageToken, ...shopCall(session, "/finance/unsettled") }),
    async (page) => {
      invalid += page.invalid;
      for (const id of page.invalidIds) noteFinanceProblem(counts, { id: `unsettled:${id}`, kind: "invalid", code: "invalid_record" });
      for (const record of page.records) {
        try {
          const result = await storeTikTokUnsettledTransaction(session.db, record, session.clock());
          counts.unsettled += 1;
          if (result.tiktokOrderId) touched.add(result.tiktokOrderId);
        } catch (error) {
          invalid += 1;
          noteFinanceProblem(counts, { id: `unsettled:${record.transactionId}`, kind: "store_failed", code: applyErrorCode(error) });
        }
      }
    },
  );
  counts.invalid += invalid;
  if (invalid > 0) throw new SyncIncomplete("finance_invalid");
  await advanceOrdersCursor(session.db, to, "unsettled");
}

/** The oldest stored record of a resource that may still change (plan §8.3 reopen). */
async function reopenFrom(db: Database, resource: "statements" | "payments", now: Date): Promise<Date | null> {
  const floor = new Date(now.getTime() - TIKTOK_FINANCE_REOPEN_MAX_MS).toISOString();
  const [row] =
    resource === "statements"
      ? await db.execute<{ at: string | Date | null }>(sql`
          select min(statement_time) as at from tiktok_statements
          where statement_time >= ${floor}::timestamptz
            and (payment_status is distinct from 'PAID' or held_reason is not null or transactions_complete_sha256 is null)`)
      : await db.execute<{ at: string | Date | null }>(sql`
          select min(create_time) as at from tiktok_payouts
          where create_time >= ${floor}::timestamptz and (status is null or status not in ('PAID', 'FAILED') or held_reason is not null)`);
  return row?.at ? new Date(row.at) : null;
}

/** Get Statements by `statement_time` (+ reopen), then every statement's transactions when its content
 * is new or not complete, then the SKU-level fees of the orders they name. */
async function pollStatements(session: Session, summary: TikTokSyncSummary, touched: Set<string>): Promise<void> {
  const counts = summary.finance;
  const cursor = await readOrdersCursor(session.db, session.clock(), "statements");
  const windows = planTikTokFinanceWindows(cursor, session.clock(), await reopenFrom(session.db, "statements", session.clock()));
  // A window with a problem holds the cursor where it is, but the later windows are still read and
  // stored (one bad statement never stops newer ones), and the order fees are fetched in any case.
  let held = false;
  try {
    for (const window of windows) {
      if (await pollStatementWindow(session, summary, touched, window)) held = true;
      else if (!held) await advanceOrdersCursor(session.db, window.end, "statements");
    }
  } finally {
    await fetchOrderFees(session, summary, touched);
  }
  if (held) throw new SyncIncomplete("finance_invalid");
}

/** One statement window; true when something in it could not be stored (the cursor must stay). */
async function pollStatementWindow(session: Session, summary: TikTokSyncSummary, touched: Set<string>, window: { start: Date; end: Date }): Promise<boolean> {
  const counts = summary.finance;
  {
    let problems = 0;
    const needing: TikTokStatementProjection[] = [];
    await eachPage(
      session,
      "/finance/statements",
      (pageToken) => getTikTokStatements(session.deps.api, { from: window.start, to: window.end, pageToken, ...shopCall(session, "/finance/statements") }),
      async (page) => {
        problems += page.invalid;
        counts.invalid += page.invalid;
        for (const id of page.invalidIds) noteFinanceProblem(counts, { id: `statement:${id}`, kind: "invalid", code: "invalid_record" });
        for (const record of page.records) {
          try {
            const result = await storeTikTokStatement(session.db, record, session.clock());
            counts.statements += 1;
            if (record.problem !== null) counts.statementsHeld += 1;
            if (result.needsTransactions) needing.push(record);
          } catch (error) {
            problems += 1;
            noteFinanceProblem(counts, { id: `statement:${record.statementId}`, kind: "store_failed", code: applyErrorCode(error) });
          }
        }
      },
    );
    for (const statement of needing) {
      const records: TikTokStatementTransactionProjection[] = [];
      let invalid = 0;
      try {
        await eachPage(
          session,
          "/finance/statement_transactions",
          (pageToken) => getTikTokStatementTransactions(session.deps.api, statement.statementId, { pageToken, ...shopCall(session, "/finance/statement_transactions") }),
          async (page) => {
            records.push(...page.records);
            invalid += page.invalid;
            for (const id of page.invalidIds) noteFinanceProblem(counts, { id: `transaction:${id}`, kind: "invalid", code: "invalid_record" });
          },
        );
      } catch (error) {
        // One statement TikTok refuses must not stop the others (like an order's fees): named, the
        // window held, retried next run. A rate limit, an outage, the budget or auth stop the run.
        if (!(error instanceof TikTokApiError) || (error.kind !== "api" && error.kind !== "invalid_response")) throw error;
        counts.failed += 1;
        noteFinanceProblem(counts, { id: `statement:${statement.statementId}`, kind: "failed", code: tiktokErrorCode(error) });
        problems += 1;
        continue;
      }
      counts.invalid += invalid;
      try {
        const stored = await storeTikTokStatementTransactions(session.db, statement, records, session.clock(), invalid);
        counts.statementTransactions += stored.inserted;
        // A transaction TikTok sent without an id cannot be counted: the statement cannot add up.
        if (!stored.complete || invalid > 0) counts.statementsHeld += 1;
        for (const id of stored.tiktokOrderIds) touched.add(id);
      } catch (error) {
        problems += 1;
        noteFinanceProblem(counts, { id: `statement:${statement.statementId}`, kind: "store_failed", code: applyErrorCode(error) });
      }
      if (invalid > 0) problems += 1;
    }
    return problems > 0;
  }
}

/** Get Transactions by Order for orders whose settled transactions have no SKU lines yet (oldest
 * first, at most 100 per run; the rest waits for the next run). */
async function fetchOrderFees(session: Session, summary: TikTokSyncSummary, touched: Set<string>): Promise<void> {
  const counts = summary.finance;
  for (const tiktokOrderId of await listTikTokOrdersWithPendingFees(session.db, TIKTOK_ORDER_FEE_FETCHES_PER_RUN)) {
    if (!budgetLeft(session)) throw budgetError("/finance/order_transactions");
    let projection;
    try {
      projection = await getTikTokOrderTransactions(session.deps.api, tiktokOrderId, shopCall(session, "/finance/order_transactions"));
    } catch (error) {
      // One order TikTok refuses (an `api` code, an answer not in the expected shape) must not stop
      // every other order's fees: it stays pending, is named, and is retried next run. A rate limit,
      // an outage, the budget or an auth failure stops the run as everywhere else.
      if (!(error instanceof TikTokApiError) || (error.kind !== "api" && error.kind !== "invalid_response")) throw error;
      counts.failed += 1;
      noteFinanceProblem(counts, { id: `order:${tiktokOrderId}`, kind: "failed", code: tiktokErrorCode(error) });
      continue;
    }
    counts.orderFetches += 1;
    if (projection.invalid > 0) {
      counts.invalid += projection.invalid;
      noteFinanceProblem(counts, { id: `order:${tiktokOrderId}`, kind: "invalid", code: "invalid_record" });
    }
    try {
      const stored = await storeTikTokOrderTransactions(session.db, projection, session.clock());
      counts.orderFeesHeld += stored.held;
      if (stored.missing > 0) {
        counts.orderFeesMissing += stored.missing;
        noteFinanceProblem(counts, { id: `order:${tiktokOrderId}`, kind: "invalid", code: "transaction_missing" });
      }
      touched.add(tiktokOrderId);
    } catch (error) {
      noteFinanceProblem(counts, { id: `order:${tiktokOrderId}`, kind: "store_failed", code: applyErrorCode(error) });
      counts.failed += 1;
    }
  }
}

/** One Get Payments window; true when something in it could not be stored (the cursor must stay). */
async function pollPaymentWindow(session: Session, summary: TikTokSyncSummary, window: TikTokPollWindow): Promise<boolean> {
  const counts = summary.finance;
  let problems = 0;
  await eachPage(
    session,
    "/finance/payments",
    (pageToken) => getTikTokPayments(session.deps.api, { from: window.start, to: window.end, pageToken, ...shopCall(session, "/finance/payments") }),
    async (page) => {
      problems += page.invalid;
      counts.invalid += page.invalid;
      for (const id of page.invalidIds) noteFinanceProblem(counts, { id: `payment:${id}`, kind: "invalid", code: "invalid_record" });
      for (const record of page.records) {
        try {
          await storeTikTokPayout(session.db, record, session.clock());
          counts.payouts += 1;
        } catch (error) {
          problems += 1;
          noteFinanceProblem(counts, { id: `payment:${record.paymentId}`, kind: "store_failed", code: applyErrorCode(error) });
        }
      }
    },
  );
  return problems > 0;
}

/** Get Payments by `create_time` (+ reopen for payouts not final yet). */
async function pollPayments(session: Session, summary: TikTokSyncSummary): Promise<void> {
  const cursor = await readOrdersCursor(session.db, session.clock(), "payments");
  const windows = planTikTokFinanceWindows(cursor, session.clock(), await reopenFrom(session.db, "payments", session.clock()));
  let held = false;
  for (const window of windows) {
    if (await pollPaymentWindow(session, summary, window)) held = true;
    else if (!held) await advanceOrdersCursor(session.db, window.end, "payments");
  }
  if (held) throw new SyncIncomplete("finance_invalid");
}

/** order_channel_fees for every order touched this run, plus the ones waiting for their admin order
 * or held (no TikTok call). One failure never stops the others. */
async function rebuildFees(session: Session, summary: TikTokSyncSummary, touched: Set<string>): Promise<void> {
  const counts = summary.finance;
  const ids = new Set([...touched, ...(await listTikTokOrderFeesToRebuild(session.db))]);
  for (const tiktokOrderId of ids) {
    try {
      const result = await rebuildTikTokOrderFees(session.db, tiktokOrderId, { now: session.clock() });
      if (result.kind === "applied") {
        if (result.changed) counts.feesWritten += 1;
        else counts.feesUnchanged += 1;
      } else if (result.kind === "held") counts.feesHeld += 1;
      else if (result.kind === "waiting_order") counts.feesWaiting += 1;
      else if (result.kind === "busy") {
        counts.busy += 1;
        noteFinanceProblem(counts, { id: `order:${tiktokOrderId}`, kind: "busy", code: result.code });
      }
    } catch (error) {
      counts.failed += 1;
      noteFinanceProblem(counts, { id: `order:${tiktokOrderId}`, kind: "failed", code: applyErrorCode(error) });
    }
  }
}

// ---- Backfill (T9) ---------------------------------------------------------------------------

/** One resource of the backfill: its slices in order, each stored completely before its progress moves
 * (resumable). `fetchWindow` returns true when the slice had something it could not store. */
async function backfillResource(
  session: Session,
  backfill: TikTokBackfillView,
  resource: TikTokBackfillResource,
  doneUntil: Date | null,
  sliceSeconds: number,
  fetchWindow: (window: TikTokPollWindow) => Promise<boolean>,
): Promise<void> {
  for (const window of planTikTokBackfillWindows({ from: backfill.fromTime, until: backfill.untilTime, doneUntil, sliceSeconds })) {
    if (await fetchWindow(window)) throw new SyncIncomplete(resource === "statements" || resource === "payments" ? "finance_invalid" : "order_invalid");
    await advanceTikTokBackfill(session.db, backfill.id, resource, window.end);
  }
}

/** Orders: like the live poll, but the slice size adapts (T4's known limit). A slice that started and
 * ran out of budget is halved for the next run; one that finished quickly lets the size grow back. */
async function backfillOrders(session: Session, summary: TikTokSyncSummary, backfill: TikTokBackfillView, budgetMs: number): Promise<void> {
  const counts = summary.backfill.orders;
  let slice = backfill.ordersSliceSeconds;
  let doneUntil = backfill.ordersDoneUntil;
  const done = new Set<string>();
  counts.sliceSeconds = slice;
  for (;;) {
    const [window] = planTikTokBackfillWindows({ from: backfill.fromTime, until: backfill.untilTime, doneUntil, sliceSeconds: slice });
    if (!window) return;
    const started = session.clock().getTime();
    let pages = 0;
    const storedBefore = session.counts.fetched;
    let problems: Map<string, TikTokOrderProblem>;
    try {
      problems = await searchOrderWindow(session, window, "backfill", done, () => {
        pages += 1;
        counts.pages += 1;
      });
    } catch (error) {
      // Halved only when the slice had a real share of the run: a run that reached the backfill with a
      // few seconds left says nothing about the slice's size.
      if (error instanceof TikTokApiError && error.kind === "budget_exhausted" && pages > 0 && budgetMs * 2 >= TIKTOK_SYNC_BUDGET_MS) {
        slice = nextTikTokBackfillSliceSeconds(slice, { finished: false, elapsedMs: session.clock().getTime() - started, budgetMs });
        counts.sliceSeconds = slice;
        await setTikTokBackfillSlice(session.db, backfill.id, slice);
      }
      throw error;
    } finally {
      counts.stored += session.counts.fetched - storedBefore;
    }
    counts.slices += 1;
    if (problems.size > 0) {
      summary.problems.push(...problemSample(problems));
      throw new SyncIncomplete([...problems.values()][0]!);
    }
    await advanceTikTokBackfill(session.db, backfill.id, "orders", window.end);
    doneUntil = window.end;
    const grown = nextTikTokBackfillSliceSeconds(slice, { finished: true, elapsedMs: session.clock().getTime() - started, budgetMs: TIKTOK_SYNC_BUDGET_MS });
    if (grown !== slice) {
      slice = grown;
      counts.sliceSeconds = slice;
      await setTikTokBackfillSlice(session.db, backfill.id, slice);
    }
  }
}

/** Plan T9: reads the backfill in `fetching` with what is left of the run. Throws a TikTokApiError
 * (the run's own handling) or SyncIncomplete (a slice that could not be stored; its progress stays). */
async function runTikTokBackfill(session: Session, summary: TikTokSyncSummary): Promise<void> {
  const backfill = await loadFetchingTikTokBackfill(session.db);
  if (!backfill) return;
  const counts = summary.backfill;
  counts.ran = true;
  counts.id = backfill.id;
  counts.state = backfill.state;
  const budgetMs = Math.max(0, session.deadline - session.clock().getTime());
  session.backfillId = backfill.id;
  let stoppedBy: string | null = null;
  try {
    await backfillOrders(session, summary, backfill, budgetMs);
    for (const kind of ["return", "cancellation"] as const) {
      const resource = kind === "return" ? "returns" : "cancellations";
      await backfillResource(session, backfill, resource, kind === "return" ? backfill.returnsDoneUntil : backfill.cancellationsDoneUntil, TIKTOK_POLL_SLICE_MS / 1000, async (window) => {
        counts.afterSales.slices += 1;
        const problems = await searchAfterSaleWindow(session, summary, kind, window, "backfill", () => {
          counts.afterSales.pages += 1;
        });
        if (problems.size > 0) summary.problems.push(...problemSample(problems));
        return problems.size > 0;
      });
    }
    const view = await getTikTokConnectionView(session.db);
    if (!view?.grantedScopes.includes(TIKTOK_FINANCE_SCOPE)) {
      // Never marked done without reading: the history's statements and payouts would be lost for good
      // once confirmed. The backfill waits in `fetching` (code `finance_no_scope`, a warning every run)
      // until the scope is granted (reconnect), runbook §14 step 9.
      counts.finance.skipped = "no_scope";
      stoppedBy = "finance_no_scope";
      return;
    } else {
      const touched = new Set<string>();
      await backfillResource(session, backfill, "statements", backfill.statementsDoneUntil, TIKTOK_FINANCE_SLICE_MS / 1000, async (window) => {
        counts.finance.windows += 1;
        return pollStatementWindow(session, summary, touched, window);
      });
      await backfillResource(session, backfill, "payments", backfill.paymentsDoneUntil, TIKTOK_FINANCE_SLICE_MS / 1000, async (window) => {
        counts.finance.windows += 1;
        return pollPaymentWindow(session, summary, window);
      });
      // The SKU-level fees of the orders these statements name are fetched by the live finance step
      // (pending transactions, oldest first), and written once each order is linked.
    }
    if (await markTikTokBackfillFetched(session.db, backfill.id, session.clock())) counts.state = "fetched";
  } catch (error) {
    stoppedBy = error instanceof SyncIncomplete ? error.code : error instanceof TikTokApiError ? (error.kind === "budget_exhausted" ? "budget_exhausted" : tiktokErrorCode(error)) : "failed";
    throw error;
  } finally {
    session.backfillId = null;
    counts.stoppedBy = stoppedBy;
    try {
      await recordTikTokBackfillRun(session.db, backfill.id, session.clock(), stoppedBy, { keepError: stoppedBy === "budget_exhausted" });
    } catch {
      // Bookkeeping only: never masks the run's own outcome (the next run records it again).
    }
  }
}

// ---- Listings for the stock sync (S1, read only) ----------------------------------------------

/** The listing read pass runs at most every 15 minutes (docs/plans/tiktok-stock-sync.md §4). */
export const TIKTOK_LISTINGS_EVERY_MS = 15 * 60_000;
/** Search Products needs the product read scope; Get Warehouse List the logistics one. */
export const TIKTOK_LISTINGS_SCOPES = ["seller.product.basic", "seller.logistics"] as const;

async function listingsSkip(session: Session): Promise<TikTokListingCounts["skipped"]> {
  const view = await getTikTokConnectionView(session.db);
  if (!TIKTOK_LISTINGS_SCOPES.every((scope) => view?.grantedScopes.includes(scope))) return "no_scope";
  const [row] = await session.db.execute<{ last_ok_at: string | Date | null }>(sql`select last_ok_at from tiktok_sync_cursors where resource = 'products'`);
  const lastOk = row?.last_ok_at ? new Date(row.last_ok_at).getTime() : null;
  if (lastOk === null || session.clock().getTime() - lastOk >= TIKTOK_LISTINGS_EVERY_MS) return null;
  // S2: TikTok refused a push for a listing's status, SKU or warehouse: re-read now, not in 15 minutes.
  const [reread] = await session.db.execute<{ due: boolean }>(sql`
    select exists (
      select 1 from tiktok_listing_skus
      where connection_id = ${session.connectionId}::uuid and last_push_error_at > read_at and last_push_error_code in (${sql.join(TIKTOK_STOCK_REREAD_CODES.map((code) => sql`${code}`), sql`, `)})
    ) as due
  `);
  return reread?.due ? null : "not_due";
}

/** One read pass (plan §4). Rows are stored product by product; only a pass that read every page with
 * no unusable entry marks unseen SKUs `not_listed` and sets several-listing holds (R7, R9). An unusable
 * entry → `incomplete` (listings_invalid). Running out of this step's budget stops quietly: the next run
 * reads again (the cursor's `last_ok_at` did not move). */
async function readTikTokListings(session: Session, summary: TikTokSyncSummary): Promise<void> {
  const counts = summary.listings;
  const passStart = new Date(Math.floor(session.clock().getTime() / 1000) * 1000);
  await readOrdersCursor(session.db, passStart, "products");
  const warehouses = await getTikTokWarehouses(session.deps.api, shopCall(session, "/logistics/warehouses"));
  const own = ownTikTokWarehouseIds(warehouses.warehouses);
  counts.ownWarehouses = own.size;
  counts.invalid += warehouses.invalid;
  let pageToken: string | null = null;
  const seenTokens = new Set<string>();
  let entries = 0;
  let totalCount: number | null = null;
  const refused = (detail: string) => new TikTokApiError({ kind: "invalid_response", path: "/product/search", httpStatus: null, code: null, requestId: null, detail });
  for (;;) {
    if (!budgetLeft(session)) throw budgetError("/product/search");
    const page = await searchTikTokProducts(session.deps.api, { pageToken, ...shopCall(session, "/product/search") });
    counts.pages += 1;
    counts.invalid += page.invalid;
    entries += page.entries;
    totalCount = page.totalCount ?? totalCount;
    for (const product of page.products) {
      counts.invalid += product.invalidSkus;
      const stored = await storeTikTokListingProduct(session.db, { connectionId: session.connectionId, product, ownWarehouses: own, readAt: passStart });
      counts.products += 1;
      counts.skus += stored.skus;
      counts.autoMapped += stored.autoMapped.length;
    }
    if (!page.nextPageToken) break;
    if (seenTokens.has(page.nextPageToken)) throw refused("page_token_repeated");
    if (counts.pages >= TIKTOK_MAX_PAGES_PER_SLICE) throw refused("too_many_pages");
    seenTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }
  // The last page came without a token: if TikTok said how many products there are, every one of them
  // must have been seen, or a missing/renamed token ended the read early (its SKUs would be not_listed).
  if (totalCount !== null && entries !== totalCount) throw refused("count_mismatch");
  // An entry without a usable id could be a real SKU: never mark anything not_listed on such a pass.
  if (counts.invalid > 0) {
    counts.stoppedBy = "listings_invalid";
    throw new SyncIncomplete("listings_invalid");
  }
  const finished = await finishTikTokListingPass(session.db, { connectionId: session.connectionId, passStart });
  counts.notListed = finished.notListed;
  counts.severalListings = finished.severalListings;
  counts.drift = await queueTikTokListingDrift(session.db, { connectionId: session.connectionId, passStart });
  counts.complete = true;
}

// ---- The stock push's drain (S2) ----------------------------------------------------------------

function pushContext(session: Session): TikTokStockPushContext {
  return { db: session.db, api: session.deps.api, connectionId: session.connectionId, call: (path) => shopCall(session, path), clock: session.clock, deadline: session.deadline };
}

/** The push right after a stock change (the apps' after(), never inside the stock transaction): the same
 * drain as the cron's, without its upkeep. Returns null when there is nothing to do (checked before any
 * credential is loaded). Throws only for a database or programming failure; the caller logs and drops it
 * (the cron retries). */
export async function pushTikTokStockNow(db: Database, deps: TikTokSyncDeps, options: { budgetMs?: number } = {}): Promise<TikTokStockPushCounts | null> {
  if (!(await tiktokStockPushDue(db))) return null;
  // A closed gate (scope, stale listings) is known without loading or refreshing any credential.
  const gate = await tiktokStockPushGate(db);
  if (!gate.ok) return { ...emptyTikTokStockPushCounts(), skipped: gate.reason };
  const clock = deps.now ?? (() => new Date());
  const summary = emptySummary();
  const session = await openSession(db, deps, clock, clock().getTime() + (options.budgetMs ?? TIKTOK_STOCK_PUSH_NOW_BUDGET_MS), summary);
  const counts = emptyTikTokStockPushCounts();
  if (typeof session === "string") {
    counts.skipped = session;
    return counts;
  }
  await drainTikTokStockOutbox(pushContext(session), counts);
  return counts;
}

/** The budget of one after() push. */
export const TIKTOK_STOCK_PUSH_NOW_BUDGET_MS = 40_000;

// ---- Health on the connection and the cursor -------------------------------------------------

/** Best effort, like T3's "last webhook": a row a token refresh holds is skipped, never waited for. */
async function recordHealth(db: Database, now: Date, outcome: { ok: true } | { ok: false; code: string }, touched: readonly CursorResource[]): Promise<void> {
  const time = now.toISOString();
  for (const resource of touched) {
    await db.execute(
      outcome.ok
        ? sql`update tiktok_sync_cursors set last_ok_at = ${time}::timestamptz, last_error_code = null, updated_at = now() where resource = ${resource}`
        : sql`update tiktok_sync_cursors set last_error_code = ${outcome.code.slice(0, 64)}, updated_at = now() where resource = ${resource}`,
    );
  }
  await db.execute(
    outcome.ok
      ? sql`update tiktok_shop_connections set last_poll_ok_at = ${time}::timestamptz where id in (select id from tiktok_shop_connections where status = 'active' for update skip locked)`
      : sql`update tiktok_shop_connections set last_error_code = ${outcome.code.slice(0, 64)}, last_error_at = ${time}::timestamptz where id in (select id from tiktok_shop_connections where status = 'active' for update skip locked)`,
  );
}

/** `last_ok_at` on cursors whose poll finished this run, when another one failed. */
async function recordCursorsOk(db: Database, now: Date, resources: readonly CursorResource[]): Promise<void> {
  for (const resource of resources) {
    await db.execute(sql`update tiktok_sync_cursors set last_ok_at = ${now.toISOString()}::timestamptz, last_error_code = null, updated_at = now() where resource = ${resource}`);
  }
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

  const session = await openSession(db, deps, clock, deadline, summary);
  if (typeof session === "string") {
    summary.connection = session;
    return summary;
  }
  summary.connection = "active";

  // Each poll runs on its own cursor. A slice that could not be fully stored (`incomplete`) holds only
  // its own cursor: the next poll still runs, so a stuck returns slice never starves cancellations
  // or the orders poll. A TikTok error (rate limit, unavailable, budget) stops the run as before.
  const done: CursorResource[] = [];
  const held: CursorResource[] = [];
  let current: CursorResource | null = null;
  let incomplete: SyncIncomplete | null = null;
  const poll = async (resource: CursorResource, run: () => Promise<void>) => {
    current = resource;
    try {
      await run();
      done.push(resource);
    } catch (error) {
      if (!(error instanceof SyncIncomplete)) throw error;
      incomplete ??= error;
      held.push(resource);
    }
    current = null;
  };
  try {
    // 3a. Re-check what is stored and not applied yet (no TikTok call), so a newly mapped SKU or a
    // passed packing gate never waits for a new version from TikTok. Then the same for returns and
    // cancellations (T6): requests waiting for their order, and response deadlines that passed.
    await recheckStoredOrders(session, options.budgetMs ?? TIKTOK_SYNC_BUDGET_MS);
    await recheckStoredAfterSales(session, options.budgetMs ?? TIKTOK_SYNC_BUDGET_MS);
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
    // 4. The poll. 5. Returns and cancellations (T6).
    await poll("orders", () => pollOrders(session, summary));
    await poll("returns", () => pollAfterSales(session, summary, "return"));
    await poll("cancellations", () => pollAfterSales(session, summary, "cancellation"));
    // 6. Finance (T7), every 30 minutes; the fee rebuild runs after the three polls, also when one
    // was held, so what was stored is applied.
    summary.finance.skipped = await financeSkip(session);
    if (summary.finance.skipped === null) {
      const touched = new Set<string>();
      try {
        await poll("unsettled", () => pollUnsettled(session, summary, touched));
        await poll("statements", () => pollStatements(session, summary, touched));
        await poll("payments", () => pollPayments(session, summary));
      } finally {
        // Never masks the poll's own error: a failure here is counted (route 500), not thrown.
        try {
          await rebuildFees(session, summary, touched);
        } catch (error) {
          summary.finance.failed += 1;
          noteFinanceProblem(summary.finance, { id: "rebuild", kind: "failed", code: applyErrorCode(error) });
        }
      }
    }
    // 6b. The listing read pass for the stock sync (S1, read only), every 15 minutes, at most a
    // quarter of the budget. Running out of that share is not an error: the next run reads again.
    summary.listings.skipped = await listingsSkip(session);
    if (summary.listings.skipped === null) {
      const fullDeadline = session.deadline;
      session.deadline = Math.min(fullDeadline, clock().getTime() + Math.floor((options.budgetMs ?? TIKTOK_SYNC_BUDGET_MS) / 4));
      try {
        await poll("products", async () => {
          try {
            await readTikTokListings(session, summary);
          } catch (error) {
            // A refused or unreadable answer (an endpoint version, a renamed key, A1/A2) holds only the
            // listing cursor, loudly (route 500 → ALERT), so the backfill below still runs. A rate limit,
            // an outage or an auth failure stops the run like every other step.
            if (!(error instanceof TikTokApiError && (error.kind === "api" || error.kind === "invalid_response"))) throw error;
            summary.listings.stoppedBy = error.detail ? `${tiktokErrorCode(error)}:${error.detail}`.slice(0, 64) : tiktokErrorCode(error);
            throw new SyncIncomplete("listings_invalid");
          }
        });
      } catch (error) {
        if (!(error instanceof TikTokApiError && error.kind === "budget_exhausted" && clock().getTime() < fullDeadline)) throw error;
        current = null;
        summary.listings.stoppedBy = "budget_exhausted";
        // Visible on Sinkron stok (the cursor's last error) and in the cron log (route "needs a look").
        await db.execute(sql`update tiktok_sync_cursors set last_error_code = 'budget_exhausted', updated_at = now() where resource = 'products'`);
      } finally {
        session.deadline = fullDeadline;
      }
    }
    // 6c. The stock push (S2), at most a quarter of the budget, after the read so it pushes against fresh
    // listings. Its TikTok failures are counted, never thrown (route 500 on a retryable failure → ALERT
    // after 3 runs); the marks wait with backoff.
    {
      const fullDeadline = session.deadline;
      session.deadline = Math.min(fullDeadline, clock().getTime() + Math.floor((options.budgetMs ?? TIKTOK_SYNC_BUDGET_MS) / 4));
      try {
        await prepareTikTokStockOutbox(db, summary.stockPush);
        await drainTikTokStockOutbox(pushContext(session), summary.stockPush);
      } catch (error) {
        // A database failure in the push never stops orders, returns, finance or the backfill: counted
        // (route 500 → ALERT) with its SQLSTATE or class name, and the marks wait for the next run.
        summary.stockPush.errors += 1;
        summary.stockPush.problems.push({ id: "drain", code: applyErrorCode(error) });
      } finally {
        session.deadline = fullDeadline;
      }
    }
    // 7. The backfill (T9), with what is left of the budget. An incomplete slice is loud like any
    // other (route 500 → ALERT) but holds only the backfill's own progress.
    try {
      await runTikTokBackfill(session, summary);
    } catch (error) {
      // Running out of budget is how the backfill normally ends a run (it takes what is left): not a
      // warning and not the connection's last error; it resumes next run.
      if (error instanceof TikTokApiError && error.kind === "budget_exhausted") {
        // counted in summary.backfill.stoppedBy
      } else if (error instanceof SyncIncomplete) incomplete ??= error;
      else throw error;
    }
    if (incomplete) {
      const code = (incomplete as SyncIncomplete).code;
      summary.error = { kind: "incomplete", code };
      await recordCursorsOk(db, clock(), done);
      await recordHealth(db, clock(), { ok: false, code }, held);
      return summary;
    }
    await recordHealth(db, clock(), summary.budgetExhausted ? { ok: false, code: "budget_exhausted" } : { ok: true }, done);
  } catch (error) {
    if (!(error instanceof TikTokApiError)) throw error;
    // The cursors that finished this run are healthy; only the one that failed (and any held one)
    // carries the code.
    await recordCursorsOk(db, clock(), done);
    const failing = [...held, ...(current ? [current] : [])];
    if (error.kind === "budget_exhausted") {
      // Behind, not failing: the next run carries on. Shown as the cursor's last code.
      summary.budgetExhausted = true;
      if (incomplete) summary.error = { kind: "incomplete", code: (incomplete as SyncIncomplete).code };
      await recordHealth(db, clock(), { ok: false, code: "budget_exhausted" }, failing);
      return summary;
    }
    summary.error = { kind: error.kind, code: tiktokErrorCode(error) };
    await recordHealth(db, clock(), { ok: false, code: summary.error.code }, failing);
  }
  return summary;
}

export type DrainTikTokWebhookEventResult =
  /** `apply`: what applying did with the order (T5; `enabled: false` while the switch is off). */
  | { kind: "processed"; apply: TikTokApplyCounts; afterSales: TikTokAfterSaleCounts }
  | { kind: "not_due" | "not_connected" | "reauth_required" | "budget_exhausted" }
  /** The order was not stored (missing, unusable, not storable); the event's retry is scheduled. */
  | { kind: "not_stored"; problems: { id: string; problem: TikTokOrderProblem }[] }
  | { kind: "error"; error: { kind: TikTokErrorKind; code: string } };

/** The webhook route's `after()`: re-fetches the one order this event names (read only). Not under
 * the cron lock: the store is serialized per order and idempotent, and the event's claim keeps the
 * cron from fetching it at the same time. */
export async function drainTikTokWebhookOrderEvent(db: Database, deps: TikTokSyncDeps, eventId: string, options: { budgetMs?: number } = {}): Promise<DrainTikTokWebhookEventResult> {
  const clock = deps.now ?? (() => new Date());
  const summary = emptySummary();
  const session = await openSession(db, deps, clock, clock().getTime() + (options.budgetMs ?? TIKTOK_WEBHOOK_DRAIN_BUDGET_MS), summary);
  if (typeof session === "string") return { kind: session };
  try {
    await drainOrderEvents(session, summary, { eventId, limit: 1 });
  } catch (error) {
    if (!(error instanceof TikTokApiError)) throw error;
    if (error.kind === "budget_exhausted") return { kind: "budget_exhausted" };
    return { kind: "error", error: { kind: error.kind, code: tiktokErrorCode(error) } };
  }
  if (summary.inbox.claimed === 0) return { kind: "not_due" };
  return summary.inbox.retried + summary.inbox.failed > 0 ? { kind: "not_stored", problems: summary.problems } : { kind: "processed", apply: summary.apply, afterSales: summary.afterSales };
}
