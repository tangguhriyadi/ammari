import "server-only";
import { and, asc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { orders, payments, shipments, type OrderAttentionFlag, type PaymentStatus } from "@ammari/db/schema";
import { writeAuditLog, type Database } from "../db";
import { ActionError, errorLogFields } from "../errors";
import { transitionOrderStatus } from "../orders/lifecycle";
import {
  OPEN_PAYMENT_STATUSES,
  PAID_LIKE_PAYMENT_STATUSES,
  applyPaymentStatus,
  cancelUnpaidCheckoutOrder,
  productSlugsOf,
  withAttentionFlags,
} from "./apply-status";
import { PAYMENT_STATUS_TIMEOUT_MS, PaymentProviderError, type PaymentProvider, type PaymentStatusReport } from "./provider";

// Staff actions on checkout orders in apps/admin (docs/plans/cart-checkout.md §6.5, §7, session 16;
// owner decisions 43 to 45). Manual and marketplace orders never come here (payment_status NULL).
//
// - Cancel: an unpaid order is first closed at the gateway (every open attempt's status fetched, a
//   still pending one expired, like the sweep), then cancelled under the order lock with
//   `payment_status = 'cancelled'` and `cancel_reason = 'admin'`. A payment that turns out to have
//   arrived is applied through the state machine and the cancel is refused; a gateway that cannot be
//   asked refuses it too. A payment arriving after the cancel is `paid_after_cancel` + `refund_due`
//   (the state machine). A paid order is cancelled without the gateway and flagged `refund_due`.
//   Stock and the voucher follow transitionOrderStatus (decision 44: the voucher comes back on every
//   cancel).
// - Refunds are made by hand outside the app (decision 43: Midtrans' refund API does not cover
//   virtual accounts) and recorded here per paid attempt.
// - Flags are cleared one at a time; clearing never touches another flag.
// Every change writes an audit_log row with the staff actor.

export const STAFF_CANCEL_MESSAGES = {
  notFound: "Pesanan tidak ditemukan.",
  notCheckout: "Pesanan ini bukan pesanan checkout website.",
  notCancellable: "Pesanan dengan status ini tidak bisa dibatalkan.",
  noProvider: "Pembayaran belum dikonfigurasi di admin, jadi pesanan website yang belum dibayar belum bisa dibatalkan dari sini.",
  gatewayUnavailable: "Status pembayaran belum bisa dicek. Pesanan tidak dibatalkan. Coba lagi sebentar lagi.",
  paidMeanwhile: "Pembayaran pesanan ini ternyata sudah masuk, jadi pesanan tidak dibatalkan. Muat ulang halaman untuk melihat statusnya.",
  stillPending: "Pembayaran pesanan ini masih berjalan dan belum bisa dihentikan. Pesanan tidak dibatalkan. Coba lagi sebentar lagi.",
  checkGateway: "Midtrans melaporkan status pembayaran yang perlu dicek dulu. Pesanan tidak dibatalkan. Cek transaksinya di dashboard Midtrans.",
  changed: "Status pesanan sudah berubah. Muat ulang halaman.",
  liveShipment: "Kurir sudah dipesan untuk pesanan ini. Batalkan pengiriman dulu di bagian Pengiriman, lalu batalkan pesanan.",
} as const;

/** Gateway statuses after which the buyer can no longer pay that attempt (same set as the sweep). */
const ENDED_AT_GATEWAY = new Set(["expire", "cancel", "deny", "failure"]);

export type StaffCancelOutcome =
  /** Cancelled now; `refundDue` when the buyer had paid. */
  | { outcome: "cancelled"; refundDue: boolean; orderNo: string; productSlugs: string[] }
  /** The gateway's own expiry cancelled the order while staff were cancelling it. */
  | { outcome: "already_cancelled"; orderNo: string; productSlugs: string[] };

export interface StaffCancelOptions {
  /** Per gateway call. */
  timeoutMs?: number;
  /** For all gateway calls of one cancel together (a staff member is waiting on the page). */
  totalBudgetMs?: number;
}

/** A staff cancel stops asking the gateway after this long and refuses (nothing changed locally). */
export const STAFF_CANCEL_GATEWAY_BUDGET_MS = 20_000;

/** Cancels a checkout order for staff (see the module comment). `provider` may be null when the
 * admin has no payment configuration: then only paid orders can be cancelled. Throws ActionError
 * with an Indonesian message on every refusal. */
export async function cancelCheckoutOrderByStaff(
  db: Database,
  provider: PaymentProvider | null,
  orderId: string,
  actorStaffUserId: string,
  options: StaffCancelOptions = {},
): Promise<StaffCancelOutcome> {
  const [order] = await db.select({ status: orders.status, paymentStatus: orders.paymentStatus, orderNo: orders.orderNo }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new ActionError(STAFF_CANCEL_MESSAGES.notFound);
  if (order.paymentStatus === null) throw new ActionError(STAFF_CANCEL_MESSAGES.notCheckout);
  // A second press (or another staff member, or the gateway's expiry) got there first.
  if (order.status === "cancelled") return { outcome: "already_cancelled", orderNo: order.orderNo, productSlugs: [] };
  if (order.status !== "awaiting_payment" && order.status !== "to_ship") throw new ActionError(STAFF_CANCEL_MESSAGES.notCancellable);
  if (order.paymentStatus === "pending") return cancelUnpaid(db, provider, orderId, actorStaffUserId, options);
  return cancelPaid(db, orderId, actorStaffUserId);
}

/** A paid order (`to_ship`, or still `awaiting_payment` because stock was short at payment). */
async function cancelPaid(db: Database, orderId: string, actorStaffUserId: string): Promise<StaffCancelOutcome> {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
    if (!order) throw new ActionError(STAFF_CANCEL_MESSAGES.notFound);
    if (order.status === "cancelled") return { outcome: "already_cancelled", orderNo: order.orderNo, productSlugs: [] };
    if ((order.status !== "awaiting_payment" && order.status !== "to_ship") || order.paymentStatus === null || order.paymentStatus === "pending") {
      throw new ActionError(STAFF_CANCEL_MESSAGES.changed);
    }
    // Money still held by Ammari goes back in full (plan §4.5.6: ongkir included). A refund the
    // gateway already reported in full needs no flag.
    if (!PAID_LIKE_PAYMENT_STATUSES.includes(order.paymentStatus)) {
      // expired / cancelled on an order that is still open: not a state the state machine leaves.
      console.error("[payments] staff cancel refused: open order with an unexpected payment status", { orderNo: order.orderNo, paymentStatus: order.paymentStatus });
      throw new ActionError(STAFF_CANCEL_MESSAGES.changed);
    }
    // A booked courier must be cancelled first (Phase K2): never a cancelled order with a parcel on
    // its way. Under the order lock, which bookShipment takes too.
    const [live] = await tx
      .select({ id: shipments.id })
      .from(shipments)
      .where(and(eq(shipments.orderId, order.id), notInArray(shipments.status, ["cancelled", "failed"])))
      .limit(1);
    if (live) throw new ActionError(STAFF_CANCEL_MESSAGES.liveShipment);
    const refundDue = order.paymentStatus === "paid" || order.paymentStatus === "partially_refunded";
    await transitionOrderStatus(order.id, "cancelled", actorStaffUserId, tx, { checkoutCancelByStaff: true });
    const [updated] = await tx
      .update(orders)
      .set({
        cancelReason: "admin",
        // Cancelling resolves a stock-short payment (nothing will be sold); every other flag stays.
        needsAttention: refundDue
          ? sql`array_remove(${withAttentionFlags(["refund_due"])}, 'stock_short_at_payment')`
          : sql`array_remove(${orders.needsAttention}, 'stock_short_at_payment')`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(orders.id, order.id), eq(orders.status, "cancelled")))
      .returning();
    if (!updated) throw new Error("cancelled order vanished under its lock");
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "cancel_checkout_order",
      entityType: "order",
      entityId: order.id,
      before: { status: order.status, paymentStatus: order.paymentStatus, needsAttention: order.needsAttention, cancelReason: order.cancelReason },
      after: { status: updated.status, paymentStatus: updated.paymentStatus, needsAttention: updated.needsAttention, cancelReason: updated.cancelReason, refundDue },
    });
    return { outcome: "cancelled", refundDue, orderNo: order.orderNo, productSlugs: await productSlugsOf(tx, order.id) };
  });
}

/** What the gateway said about one open attempt during this cancel. */
type Ended = { kind: "none" } | { kind: "report"; report: PaymentStatusReport };

async function cancelUnpaid(
  db: Database,
  provider: PaymentProvider | null,
  orderId: string,
  actorStaffUserId: string,
  options: StaffCancelOptions,
): Promise<StaffCancelOutcome> {
  if (!provider) {
    console.warn("[payments] staff cancel refused: no payment provider configured in admin", { orderId });
    throw new ActionError(STAFF_CANCEL_MESSAGES.noProvider);
  }
  const timeoutMs = options.timeoutMs ?? PAYMENT_STATUS_TIMEOUT_MS;
  const deadline = Date.now() + (options.totalBudgetMs ?? STAFF_CANCEL_GATEWAY_BUDGET_MS);
  // Each call gets its own timeout, cut short by the cancel's overall deadline.
  const signal = () => AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline - Date.now())));

  const open = await db
    .select({ providerOrderId: payments.providerOrderId })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), inArray(payments.status, [...OPEN_PAYMENT_STATUSES])))
    .orderBy(asc(payments.attempt));

  // 1. Every open attempt: what does the gateway say, and close it when it is still payable. No
  // gateway call ever runs inside a database transaction.
  const ended = new Map<string, Ended>();
  /** Attempts this cancel already expired at the gateway (logged if the cancel is then refused). */
  const expiredHere: string[] = [];
  const refuse = (message: string, log: Record<string, unknown>): never => {
    console.warn("[payments] staff cancel refused", { ...log, expiredAtGateway: expiredHere });
    throw new ActionError(message);
  };
  for (const { providerOrderId } of open) {
    let report: PaymentStatusReport | null;
    let step: "status" | "expire" = "status";
    try {
      if (Date.now() >= deadline) refuse(STAFF_CANCEL_MESSAGES.gatewayUnavailable, { providerOrderId, reason: "time_budget" });
      report = await provider.getPaymentStatus(providerOrderId, { signal: signal() });
      if (report?.transactionStatus === "pending") {
        step = "expire";
        const expired = await provider.expirePayment(providerOrderId, { signal: signal() });
        if (expired) expiredHere.push(providerOrderId);
        step = "status";
        report = expired ?? (await provider.getPaymentStatus(providerOrderId, { signal: signal() }));
      }
    } catch (error) {
      if (error instanceof ActionError) throw error;
      refuse(STAFF_CANCEL_MESSAGES.gatewayUnavailable, {
        providerOrderId,
        step,
        ...(error instanceof PaymentProviderError ? error.logFields() : errorLogFields(error)),
      });
      throw error;
    }
    if (!report) {
      // No transaction at the gateway: the buyer never picked a method. Its page may still be open
      // in a tab; a payment made there later is `paid_after_cancel` + `refund_due` (state machine).
      ended.set(providerOrderId, { kind: "none" });
      continue;
    }
    if (ENDED_AT_GATEWAY.has(report.transactionStatus)) {
      ended.set(providerOrderId, { kind: "report", report });
      continue;
    }
    // Paid (or anything the state machine flags): it decides, never this cancel.
    const applied = await applyPaymentStatus(db, report);
    const log = { providerOrderId, transactionStatus: report.transactionStatus, outcome: applied?.outcome ?? null };
    if (report.transactionStatus === "pending") refuse(STAFF_CANCEL_MESSAGES.stillPending, log);
    if (report.transactionStatus === "settlement") refuse(STAFF_CANCEL_MESSAGES.paidMeanwhile, log);
    refuse(STAFF_CANCEL_MESSAGES.checkGateway, log);
  }

  // 2. Under the order lock: nothing changed meanwhile, then cancel.
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
    if (!order) throw new ActionError(STAFF_CANCEL_MESSAGES.notFound);
    if (order.status === "cancelled" && order.paidAt === null) {
      // The gateway's expiry notification for the attempt just expired (or another staff cancel)
      // got here first.
      return { outcome: "already_cancelled", orderNo: order.orderNo, productSlugs: [] };
    }
    if (order.status !== "awaiting_payment" || order.paymentStatus !== "pending") {
      throw new ActionError(order.paymentStatus === "paid" ? STAFF_CANCEL_MESSAGES.paidMeanwhile : STAFF_CANCEL_MESSAGES.changed);
    }
    const attempts = await tx
      .select({ id: payments.id, providerOrderId: payments.providerOrderId, status: payments.status })
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .orderBy(asc(payments.attempt))
      .for("update");
    if (attempts.some((attempt) => PAID_LIKE_PAYMENT_STATUSES.includes(attempt.status))) throw new ActionError(STAFF_CANCEL_MESSAGES.paidMeanwhile);
    const stillOpen = attempts.filter((attempt) => OPEN_PAYMENT_STATUSES.includes(attempt.status));
    // A new attempt opened after step 1 (the buyer pressed "Buka halaman pembayaran"): not asked.
    if (stillOpen.some((attempt) => !ended.has(attempt.providerOrderId))) throw new ActionError(STAFF_CANCEL_MESSAGES.changed);

    await cancelUnpaidCheckoutOrder(tx, order.id, {
      attempts: stillOpen.map((attempt) => {
        const seen = ended.get(attempt.providerOrderId);
        const status: "expired" | "cancelled" = seen?.kind === "report" && seen.report.transactionStatus === "expire" ? "expired" : "cancelled";
        return { id: attempt.id, status, ...(seen?.kind === "report" ? { snapshot: seen.report.snapshot } : {}) };
      }),
      paymentStatus: "cancelled",
      cancelReason: "admin",
      actorStaffUserId,
    });
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "cancel_checkout_order",
      entityType: "order",
      entityId: order.id,
      before: { status: order.status, paymentStatus: order.paymentStatus, needsAttention: order.needsAttention, cancelReason: order.cancelReason },
      after: {
        status: "cancelled",
        paymentStatus: "cancelled",
        needsAttention: order.needsAttention,
        cancelReason: "admin",
        attemptsEnded: stillOpen.map((attempt) => attempt.providerOrderId),
        // What the gateway said per attempt: "none" = no transaction there (nothing to close).
        gateway: Object.fromEntries(stillOpen.map((attempt) => {
          const seen = ended.get(attempt.providerOrderId);
          return [attempt.providerOrderId, seen?.kind === "report" ? seen.report.transactionStatus : "none"];
        })),
      },
    });
    return { outcome: "cancelled", refundDue: false, orderNo: order.orderNo, productSlugs: await productSlugsOf(tx, order.id) };
  });
}

// ---------- refunds recorded by hand (decision 43) ----------

export const REFUND_NOTE_MAX_LENGTH = 200;

export const REFUND_MESSAGES = {
  notFound: "Pembayaran tidak ditemukan untuk pesanan ini.",
  notPaid: "Pembayaran ini tidak tercatat dibayar, atau dananya sudah dikembalikan.",
  noRefundDue: "Pesanan ini tidak ditandai perlu pengembalian dana.",
  lastPayment: "Ini satu-satunya pembayaran pesanan yang masih berjalan. Batalkan pesanan dulu sebelum mengembalikan dananya.",
  note: "Tulis catatan pengembalian dana, misalnya bank dan tanggal transfer.",
} as const;

export interface RecordRefundResult {
  orderNo: string;
  amount: number;
  /** `refund_due` was cleared: nothing more is owed on this order. */
  settled: boolean;
}

/** Records that Ammari refunded one paid attempt in full by hand (bank transfer, or the gateway
 * dashboard). Only on an order flagged `refund_due`; never the last paid attempt of an order that is
 * still going ahead (cancel it first). The attempt becomes `refunded`; the order's payment status
 * becomes `refunded` once a cancelled order has no paid attempt left; `refund_due` (and
 * `paid_after_cancel`) are cleared when nothing more is owed. Conditional writes under the order lock, so a second press records nothing. */
export async function recordManualRefund(
  db: Database,
  input: { orderId: string; paymentId: string; note: string },
  actorStaffUserId: string,
): Promise<RecordRefundResult> {
  const note = input.note.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (note.length < 3 || note.length > REFUND_NOTE_MAX_LENGTH) throw new ActionError(REFUND_MESSAGES.note);

  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).for("update").limit(1);
    if (!order || order.paymentStatus === null) throw new ActionError(REFUND_MESSAGES.notFound);
    if (!order.needsAttention.includes("refund_due")) throw new ActionError(REFUND_MESSAGES.noRefundDue);
    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.id, input.paymentId), eq(payments.orderId, order.id)))
      .for("update")
      .limit(1);
    if (!payment) throw new ActionError(REFUND_MESSAGES.notFound);
    if (payment.status !== "paid" && payment.status !== "partially_refunded") throw new ActionError(REFUND_MESSAGES.notPaid);

    const others = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.orderId, order.id), ne(payments.id, payment.id), inArray(payments.status, ["paid", "partially_refunded"] satisfies PaymentStatus[])));
    const orderGoesAhead = order.status !== "cancelled" && order.status !== "returned";
    if (orderGoesAhead && others.length === 0) throw new ActionError(REFUND_MESSAGES.lastPayment);

    const amount = payment.grossAmount - payment.refundedAmount;
    await tx
      .update(payments)
      .set({ status: "refunded", refundedAmount: payment.grossAmount, updatedAt: sql`now()` })
      .where(and(eq(payments.id, payment.id), inArray(payments.status, ["paid", "partially_refunded"] satisfies PaymentStatus[])));

    // Still owed after this one: the other paid attempts, less the one that pays for an order
    // going ahead.
    const settled = refundsOwed(order.status, others.length) === 0;
    const [updated] = await tx
      .update(orders)
      .set({
        ...(!orderGoesAhead && others.length === 0 ? { paymentStatus: "refunded" as const } : {}),
        // Nothing more owed: `refund_due` is done, and so is `paid_after_cancel` (the money that
        // arrived after the cancel went back). Every other flag stays.
        ...(settled ? { needsAttention: sql`array_remove(array_remove(${orders.needsAttention}, 'refund_due'), 'paid_after_cancel')` } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(orders.id, order.id))
      .returning({ paymentStatus: orders.paymentStatus, needsAttention: orders.needsAttention });

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "record_refund",
      entityType: "order",
      entityId: order.id,
      before: { paymentStatus: order.paymentStatus, needsAttention: order.needsAttention, payment: { id: payment.id, providerOrderId: payment.providerOrderId, status: payment.status, refundedAmount: payment.refundedAmount } },
      after: { paymentStatus: updated?.paymentStatus, needsAttention: updated?.needsAttention, payment: { id: payment.id, providerOrderId: payment.providerOrderId, status: "refunded", refundedAmount: payment.grossAmount }, amount, note },
    });
    return { orderNo: order.orderNo, amount, settled };
  });
}

// ---------- flags ----------

export const FLAG_MESSAGES = {
  notFound: "Pesanan tidak ditemukan.",
  alreadyCleared: "Tanda ini sudah tidak ada. Mungkin sudah ditandai beres oleh orang lain. Muat ulang halaman.",
  stockShortOpen: "Pesanan ini masih menunggu. Proses pesanan (setelah stok ditambah) atau batalkan dan kembalikan dananya.",
  refundOwed: "Dana pembeli masih tercatat belum dikembalikan. Kembalikan dananya, lalu pakai Catat dana dikembalikan.",
} as const;

/** Paid attempts whose money Ammari still holds but must give back: every paid attempt of a
 * cancelled (or returned) order, every paid attempt but one of an order going ahead. */
export function refundsOwed(orderStatus: string, paidAttempts: number): number {
  const goesAhead = orderStatus !== "cancelled" && orderStatus !== "returned";
  return Math.max(0, goesAhead ? paidAttempts - 1 : paidAttempts);
}

/** Clears one `needs_attention` flag (owner decision 2026-10-20: per flag, never another). Two staff
 * clearing the same flag at once: the order lock serializes them and the second is told it is
 * already gone. `stock_short_at_payment` cannot be cleared while the order still waits for "Proses"
 * or a cancel, so a paid order never drops out of "Perlu dicek" unhandled. */
export async function clearAttentionFlag(db: Database, orderId: string, flag: OrderAttentionFlag, actorStaffUserId: string): Promise<{ orderNo: string; needsAttention: OrderAttentionFlag[] }> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, orderNo: orders.orderNo, status: orders.status, needsAttention: orders.needsAttention })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update")
      .limit(1);
    if (!order) throw new ActionError(FLAG_MESSAGES.notFound);
    if (!order.needsAttention.includes(flag)) throw new ActionError(FLAG_MESSAGES.alreadyCleared);
    if (flag === "stock_short_at_payment" && order.status === "awaiting_payment") throw new ActionError(FLAG_MESSAGES.stockShortOpen);
    // Money still owed never drops out of "Perlu dicek" by a click: it ends with a recorded refund
    // (recordManualRefund), or when the gateway reports the refund (the attempt is then refunded).
    if (flag === "refund_due" || flag === "paid_after_cancel") {
      const paid = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(and(eq(payments.orderId, order.id), inArray(payments.status, ["paid", "partially_refunded"] satisfies PaymentStatus[])))
        .for("update");
      if (refundsOwed(order.status, paid.length) > 0) throw new ActionError(FLAG_MESSAGES.refundOwed);
    }
    const [updated] = await tx
      .update(orders)
      .set({ needsAttention: sql`array_remove(${orders.needsAttention}, ${flag}::text)`, updatedAt: sql`now()` })
      .where(and(eq(orders.id, order.id), sql`${flag}::text = any(${orders.needsAttention})`))
      .returning({ needsAttention: orders.needsAttention });
    if (!updated) throw new ActionError(FLAG_MESSAGES.alreadyCleared);
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "clear_attention_flag",
      entityType: "order",
      entityId: order.id,
      before: { needsAttention: order.needsAttention },
      after: { needsAttention: updated.needsAttention, cleared: flag },
    });
    return { orderNo: order.orderNo, needsAttention: updated.needsAttention };
  });
}
