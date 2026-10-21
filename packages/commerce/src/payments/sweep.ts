import "server-only";
import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { orders, payments, stockReservations, type PaymentStatus } from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";
import type { Database } from "../db";
import { errorLogFields } from "../errors";
import { applyPaymentStatus, expireOrderWithoutLiveTransaction, type ApplyOutcome } from "./apply-status";
import { PAYMENT_STATUS_TIMEOUT_MS, PaymentProviderError, type PaymentProvider, type PaymentStatusReport } from "./provider";

// The expiry sweep (docs/plans/cart-checkout.md §6.3, D13), run every 5 minutes by the internal
// cron service through apps/web's `POST /api/internal/payments/sweep`. It only ever looks at
// existing checkout orders, so it is safe while STOREFRONT_CART_ENABLED is off.
//
// Candidates: checkout orders still `awaiting_payment` with `payment_status = 'pending'` whose
// payment window (`payment_expires_at`, 60 minutes) is over, oldest first, matching the partial
// index `orders_checkout_awaiting_payment_idx`. An order paid while stock was short
// (`payment_status = 'paid'`, flagged `stock_short_at_payment`) is never a candidate: its holds are
// never released and it is never cancelled here.
//
// Per order:
// 1. Every open attempt (created / pending / failed), not only the latest, gets a server-to-server
//    status fetch, and each answer goes through the one state machine (applyPaymentStatus): a late
//    settlement is paid, a gateway expiry of the latest attempt cancels the order, an older
//    attempt's end never does.
// 2. Between the end of the payment window and the end of the stock hold (75 minutes; the order's
//    reservations decide, so a changed CHECKOUT_STOCK_HOLD_MINUTES never shortens a placed order's
//    hold) nothing more happens: a buyer who paid at the last minute still has their pieces, and a
//    late notification still finds them.
// 3. After the hold: every attempt the gateway still reports as pending is expired at the gateway
//    (Midtrans `POST /v2/{order_id}/expire`, owner decision 2026-10-21), and its answer (or a fresh
//    status fetch when the gateway refused) goes through the state machine.
// 4. If the order is still open and every open attempt is confirmed ended in this run (no
//    transaction at the gateway, or an ended status), it is expired locally
//    (expireOrderWithoutLiveTransaction, owner decision 2026-10-21). A gateway that cannot be asked
//    leaves the order for the next run: nothing is ever ended without the gateway's word.
//
// An order the sweep cannot end (gateway unreachable, or a status it never ends, which the state
// machine has flagged for staff) stays a candidate and is logged as an error on every run once it
// is SWEEP_STUCK_AFTER_MINUTES past its window; flagged orders are swept last so they never fill
// the batch. Its stock hold has lapsed on its own by then (holds count only while unexpired).
//
// Holds are released and the voucher restored by transitionOrderStatus, inside the same
// transaction as the cancel. The caller revalidates the product pages in `productSlugs`.

/** Candidates per run; the rest wait for the next run (oldest first). */
export const SWEEP_BATCH_SIZE = 50;
/** No new order, and no new step of an order, is started after this much of a run (the cron calls
 * every 5 minutes). */
export const SWEEP_TIME_BUDGET_MS = 4 * 60 * 1000;
/** An order still open this long after its payment window is logged as an error on every run
 * (stuck: the gateway is unreachable, or reports a status the sweep never ends). */
export const SWEEP_STUCK_AFTER_MINUTES = 6 * 60;

const OPEN: readonly PaymentStatus[] = ["created", "pending", "failed"];
/** Gateway statuses after which the attempt can no longer be paid by the buyer. `deny` and
 * `failure` are final for that transaction; the buyer could try another method inside the same
 * Snap page only while the page lives, and the sweep only ends orders after the stock hold, when
 * the page's payment window (Snap `expiry`, 60 minutes from creation) is long over. */
const ENDED_AT_GATEWAY = new Set(["expire", "cancel", "deny", "failure"]);

/** What the sweep did with one order (logged per order, counted in the summary). */
export type SweepOrderResult =
  /** The state machine or the local expiry changed the order (paid, expired, cancelled, ...). */
  | ApplyOutcome
  /** The payment window is over but the stock hold is not: nothing to do yet. */
  | "within_hold"
  /** The gateway could not be asked, or still reports a pending attempt it would not expire. */
  | "gateway_unavailable"
  | "gateway_pending"
  /** Expired locally: no live transaction at the gateway (decision 28). */
  | "expired_locally"
  /** Already finalized by something else (a notification, the finish page) during this run. */
  | "finalized_elsewhere"
  /** The run's time budget ran out in the middle of this order; it is retried next run. */
  | "deferred"
  /** An unexpected error (database or bug); the order is retried next run. */
  | "error";

export interface SweepSummary {
  candidates: number;
  /** Orders whose `payment_status` is no longer pending after this run. */
  finalized: number;
  results: { orderNo: string; result: SweepOrderResult }[];
  /** Products whose availability changed (sale or released holds). */
  productSlugs: string[];
  /** True when the batch or the time budget ran out before every candidate was seen. */
  truncated: boolean;
  /** Orders still open SWEEP_STUCK_AFTER_MINUTES after their window (each logged as an error). */
  stuck: number;
}

export interface SweepOptions {
  batchSize?: number;
  timeBudgetMs?: number;
  /** Per gateway call. */
  timeoutMs?: number;
  now?: () => number;
}

interface Candidate {
  id: string;
  orderNo: string;
  /** No active reservation of the order is still unexpired. */
  holdOver: boolean;
  /** Whole minutes since the payment window ended. */
  minutesOverdue: number;
}

async function sweepCandidates(db: Database, limit: number): Promise<Candidate[]> {
  return db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      holdOver: sql<boolean>`not exists (
        select 1 from ${stockReservations}
        where ${qualifiedColumn(stockReservations, stockReservations.orderId)} = ${qualifiedColumn(orders, orders.id)}
          and ${qualifiedColumn(stockReservations, stockReservations.status)} = 'active'
          and ${qualifiedColumn(stockReservations, stockReservations.expiresAt)} > now()
      )`,
      minutesOverdue: sql<number>`floor(extract(epoch from (now() - ${orders.paymentExpiresAt})) / 60)::int`,
    })
    .from(orders)
    .where(
      and(
        // The partial index's predicate, spelled out so the planner can use it.
        eq(orders.status, "awaiting_payment"),
        isNotNull(orders.paymentStatus),
        eq(orders.paymentStatus, "pending"),
        lte(orders.paymentExpiresAt, sql`now()`),
      ),
    )
    // Orders already flagged for staff (a card or unknown status, an amount mismatch: the sweep can
    // never end those) go last, so they cannot fill every batch and starve the others.
    .orderBy(sql`cardinality(${orders.needsAttention}) > 0`, asc(orders.paymentExpiresAt))
    .limit(limit);
}

async function openAttempts(db: Database, orderId: string): Promise<string[]> {
  const rows = await db
    .select({ providerOrderId: payments.providerOrderId })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), inArray(payments.status, [...OPEN])))
    .orderBy(asc(payments.attempt));
  return rows.map((row) => row.providerOrderId);
}

async function orderStillPending(db: Database, orderId: string): Promise<boolean> {
  const [row] = await db.select({ status: orders.status, paymentStatus: orders.paymentStatus }).from(orders).where(eq(orders.id, orderId)).limit(1);
  return row?.status === "awaiting_payment" && row.paymentStatus === "pending";
}

function gatewayErrorFields(error: unknown): Record<string, unknown> {
  return error instanceof PaymentProviderError ? error.logFields() : errorLogFields(error);
}

/** What the gateway said about one attempt in this run. */
type GatewayView = { kind: "report"; report: PaymentStatusReport } | { kind: "none" } | { kind: "unavailable" };

async function sweepOrder(db: Database, provider: PaymentProvider, candidate: Candidate, timeoutMs: number, slugs: Set<string>, outOfTime: () => boolean): Promise<SweepOrderResult> {
  const signal = () => AbortSignal.timeout(timeoutMs);
  let last: SweepOrderResult = "unchanged";
  const apply = async (report: PaymentStatusReport): Promise<void> => {
    const applied = await applyPaymentStatus(db, report);
    if (!applied) return;
    for (const slug of applied.productSlugs) slugs.add(slug);
    if (applied.outcome !== "unchanged") last = applied.outcome;
  };

  // 1. Every open attempt's status, through the state machine.
  const views = new Map<string, GatewayView>();
  for (const providerOrderId of await openAttempts(db, candidate.id)) {
    if (outOfTime()) return "deferred";
    let view: GatewayView;
    try {
      const report = await provider.getPaymentStatus(providerOrderId, { signal: signal() });
      view = report ? { kind: "report", report } : { kind: "none" };
    } catch (error) {
      console.warn("[payments] sweep: status fetch failed", { orderNo: candidate.orderNo, providerOrderId, ...gatewayErrorFields(error) });
      view = { kind: "unavailable" };
    }
    views.set(providerOrderId, view);
    if (view.kind === "report") await apply(view.report);
  }
  if (!(await orderStillPending(db, candidate.id))) return last;

  // 2. Inside the stock hold: wait.
  if (!candidate.holdOver) return "within_hold";

  // 3. After the hold: expire what the gateway still holds open.
  for (const [providerOrderId, view] of views) {
    if (view.kind !== "report" || view.report.transactionStatus !== "pending") continue;
    if (outOfTime()) return "deferred";
    try {
      const expired = await provider.expirePayment(providerOrderId, { signal: signal() });
      // Refused (no longer pending, or gone): whatever it is now decides.
      const report = expired ?? (await provider.getPaymentStatus(providerOrderId, { signal: signal() }));
      views.set(providerOrderId, report ? { kind: "report", report } : { kind: "none" });
      if (report) await apply(report);
    } catch (error) {
      console.warn("[payments] sweep: expire at the gateway failed", { orderNo: candidate.orderNo, providerOrderId, ...gatewayErrorFields(error) });
      views.set(providerOrderId, { kind: "unavailable" });
    }
  }
  if (!(await orderStillPending(db, candidate.id))) return last;

  // 4. Nothing live at the gateway: expire locally (re-checked under the order lock).
  const ended: string[] = [];
  let unavailable = false;
  for (const [providerOrderId, view] of views) {
    if (view.kind === "none" || (view.kind === "report" && ENDED_AT_GATEWAY.has(view.report.transactionStatus))) ended.push(providerOrderId);
    else if (view.kind === "unavailable") unavailable = true;
  }
  if (unavailable) return "gateway_unavailable";
  if (ended.length !== views.size) return "gateway_pending";
  const expired = await expireOrderWithoutLiveTransaction(db, candidate.id, ended);
  if (expired) {
    for (const slug of expired.productSlugs) slugs.add(slug);
    if (expired.outcome !== "unchanged") return "expired_locally";
  }
  // Changed under us (a notification, a retry): the next run looks again.
  return (await orderStillPending(db, candidate.id)) ? "gateway_pending" : last;
}

/** One sweep run. The caller holds the run lock (withExclusiveRun) and revalidates
 * `productSlugs`. Never throws for one order's failure: it is logged and retried next run. */
export async function sweepExpiredPayments(db: Database, provider: PaymentProvider, options: SweepOptions = {}): Promise<SweepSummary> {
  const now = options.now ?? Date.now;
  const started = now();
  const batchSize = options.batchSize ?? SWEEP_BATCH_SIZE;
  const candidates = await sweepCandidates(db, batchSize);
  const slugs = new Set<string>();
  const results: SweepSummary["results"] = [];
  let finalized = 0;
  let truncated = candidates.length === batchSize;

  let stuck = 0;
  const budget = options.timeBudgetMs ?? SWEEP_TIME_BUDGET_MS;
  const outOfTime = () => now() - started > budget;

  for (const candidate of candidates) {
    if (outOfTime()) {
      truncated = true;
      break;
    }
    let result: SweepOrderResult;
    try {
      result = await sweepOrder(db, provider, candidate, options.timeoutMs ?? PAYMENT_STATUS_TIMEOUT_MS, slugs, outOfTime);
    } catch (error) {
      console.error("[payments] sweep: order not swept (unexpected error); retried next run", { orderNo: candidate.orderNo, ...errorLogFields(error) });
      result = "error";
    }
    let stillPending = true;
    try {
      stillPending = await orderStillPending(db, candidate.id);
    } catch (error) {
      console.error("[payments] sweep: could not re-read the order after sweeping it", { orderNo: candidate.orderNo, ...errorLogFields(error) });
    }
    if (!stillPending) {
      finalized += 1;
      if (result === "unchanged" || result === "within_hold" || result === "gateway_pending" || result === "gateway_unavailable") result = "finalized_elsewhere";
    }
    if (result === "deferred") truncated = true;
    if (stillPending && candidate.minutesOverdue >= SWEEP_STUCK_AFTER_MINUTES) {
      stuck += 1;
      console.error("[payments] sweep: order still unpaid and open long after its payment window; check it", { orderNo: candidate.orderNo, result, minutesOverdue: candidate.minutesOverdue });
    } else if (result !== "within_hold") {
      console.info("[payments] sweep: order", { orderNo: candidate.orderNo, result, minutesOverdue: candidate.minutesOverdue });
    }
    results.push({ orderNo: candidate.orderNo, result });
  }
  return { candidates: candidates.length, finalized, results, productSlugs: [...slugs], truncated, stuck };
}
