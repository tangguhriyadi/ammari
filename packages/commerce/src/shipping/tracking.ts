import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { orders, shipmentEvents, shipments, type OrderAttentionFlag, type OrderStatus, type ShipmentEventSource, type ShipmentStatus } from "@ammari/db/schema";
import { writeAuditLog, type Database, type Tx } from "../db";
import { ActionError, errorLogFields, isPostgresErrorCode } from "../errors";
import { withAttentionFlags } from "../orders/attention";
import { transitionOrderStatus } from "../orders/lifecycle";
import { parseShipmentDetails } from "../orders/shipment-details";
import { ShipmentProviderError, type ProviderShipment, type ShipmentProvider } from "./shipment-provider";
import { BITESHIP_FINAL_STATUSES, isShippingCostOverQuote } from "./shipment-rules";

// Courier tracking (docs/plans/cart-checkout.md §15 Phase K, K3; decision 48). Every read of a
// booked attempt, whoever triggered it (the webhook's re-fetch, the cron poller, staff's booking,
// "Cek ulang" or label print), is applied here, under the order's row lock and then the shipment's
// (the same order as every other order write, so no deadlock):
// - The courier history becomes shipment_events rows, de-duplicated on (shipment, time, status), so
//   a replayed webhook or a repeated poll never adds a row twice.
// - A read whose newest history entry is older than what is stored was taken before a newer read
//   that already landed (reads run outside any transaction and can finish out of order): only its
//   events are kept, nothing else. Without history, the status still never moves back along the
//   pickup -> transit -> delivered path, and delivered / returned are final.
// - An ended attempt (cancelled, failed) is never revived.
// - Order effects (status mapping in the plan): picked up or in transit moves a paid order
//   `to_ship -> shipped` through transitionOrderStatus with no staff actor, the quoted courier and
//   the waybill as resi (the cron email pass and the caller's hook send "sudah dikirim"); delivered
//   moves it on to `completed` (through `shipped` first if needed; the "sudah sampai" email is due
//   from then on). Never an automatic `returned`: returns, problems, a cancel we did not ask for, an
//   undocumented status, a waybill that fails the resi rule, and a parcel moving for a cancelled
//   order flag `delivery_problem` for staff.
// - Flags are raised only when what they describe changes in this read (a new status, a new price,
//   a new waybill), so a flag staff cleared is not raised again by the next identical read.
// The order is re-read under its lock and every transition re-checks it, so two reads at once (a
// webhook and a poll) apply one after the other and the second finds nothing left to do.
// Logs carry our ids, statuses and reasons only, never a courier note, name, phone or address.

export const SHIPMENT_CHANGED_MESSAGE = "Pengiriman sudah berubah. Muat ulang halaman.";

/** Attempts that ended: never read again, never revived. */
export const ENDED_SHIPMENT_STATUSES: readonly ShipmentStatus[] = ["cancelled", "failed"];
/** Booked attempts the tracking reads (not `booking`: its provider id is not known yet; staff's
 * "Cek ulang" settles those). */
export const OPEN_SHIPMENT_STATUSES: readonly ShipmentStatus[] = ["pickup_requested", "picked_up", "in_transit", "returning", "problem"];
/** Stored states nothing moves out of (a returned parcel and a delivered one stay so). */
const FINAL_STORED: ReadonlySet<ShipmentStatus> = new Set(["delivered", "returned", "cancelled", "failed"]);
/** Forward order of the normal path: a read must never move the status back along it. */
const FORWARD_RANK: Partial<Record<ShipmentStatus, number>> = { booking: 0, pickup_requested: 1, picked_up: 2, in_transit: 3, delivered: 4 };
/** The parcel has left with the courier. */
const MOVING: ReadonlySet<ShipmentStatus> = new Set(["picked_up", "in_transit", "delivered"]);
/** States that need staff (plan: flag `delivery_problem`, never an automatic order change). */
const NEEDS_STAFF: ReadonlySet<ShipmentStatus> = new Set(["problem", "returning", "returned"]);
/** Provider statuses after which nothing more is read (BITESHIP_FINAL_STATUSES, as SQL). */
const FINAL_PROVIDER_STATUSES = [...BITESHIP_FINAL_STATUSES];

/** How far in the future a courier history time may be before it is treated as wrong (clock skew). */
const FUTURE_EVENT_TOLERANCE_MS = 5 * 60_000;

/** Resi and waybill compared the way the resi rule stores them (no spaces, upper case). */
export function sameResi(a: string, b: string): boolean {
  return a.replace(/\s+/g, "").toUpperCase() === b.replace(/\s+/g, "").toUpperCase();
}

type ShipmentRow = typeof shipments.$inferSelect;
type OrderRow = typeof orders.$inferSelect;

export interface ApplySnapshotOptions {
  source: ShipmentEventSource;
  actorStaffUserId: string | null;
  /** The audit_log action. */
  action: string;
  /** The answer to a booking (K2): the attempt must still be `booking`, or already be this order. */
  expectBooking?: boolean;
}

export interface ApplySnapshotResult {
  row: ShipmentRow;
  orderId: string;
  orderNo: string;
  /** False when nothing but events could be applied (an ended attempt, a stale read, a booking
   * answer for an attempt settled meanwhile). */
  applied: boolean;
  /** The read was older than what is stored (its newest history entry is). */
  stale: boolean;
  eventsAdded: number;
  /** The price changed to more than Rp5.000 above the locked quote (decision 47). */
  overQuote: boolean;
  /** Order statuses this read moved the order to, in order (`shipped`, `completed`). */
  orderTransitions: OrderStatus[];
  flagsRaised: OrderAttentionFlag[];
}

function latestEventAt(snapshot: ProviderShipment): Date | null {
  let latest: Date | null = null;
  for (const entry of snapshot.history) if (latest === null || entry.occurredAt > latest) latest = entry.occurredAt;
  return latest;
}

/** When the history first shows a state in `states` (the courier's own time), if it does. */
function firstEventAt(snapshot: ProviderShipment, states: ReadonlySet<ShipmentStatus>): Date | null {
  for (const entry of snapshot.history) if (entry.status !== null && states.has(entry.status)) return entry.occurredAt;
  return null;
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/** The shipment's columns from what the provider says. The status moves only to a state the
 * provider sent (a booked order without one counts as waiting for pickup), never back along the
 * normal path, and never out of a final state; the raw provider status follows the state (an
 * undocumented one is stored raw while the state stays). */
function snapshotFields(previous: ShipmentRow, snapshot: ProviderShipment, latest: Date | null, now: Date): Partial<typeof shipments.$inferInsert> {
  const reported: ShipmentStatus = snapshot.status ?? (previous.status === "booking" ? "pickup_requested" : previous.status);
  const before = FORWARD_RANK[previous.status];
  const after = FORWARD_RANK[reported];
  const blocked = FINAL_STORED.has(previous.status) || (before !== undefined && after !== undefined && after < before);
  const status: ShipmentStatus = blocked ? previous.status : reported;
  return {
    providerOrderId: snapshot.providerOrderId,
    providerTrackingId: snapshot.trackingId ?? previous.providerTrackingId,
    awb: snapshot.waybillId ?? previous.awb,
    routingCode: snapshot.routingCode ?? previous.routingCode,
    trackingLink: snapshot.trackingLink ?? previous.trackingLink,
    costAmount: snapshot.price ?? previous.costAmount,
    providerStatus: blocked ? previous.providerStatus : (snapshot.providerStatus ?? previous.providerStatus),
    status,
    driverName: snapshot.driver?.name ?? previous.driverName,
    driverPhone: snapshot.driver?.phone ?? previous.driverPhone,
    driverPlateNumber: snapshot.driver?.plateNumber ?? previous.driverPlateNumber,
    bookedAt: previous.bookedAt ?? now,
    pickedUpAt: previous.pickedUpAt ?? (MOVING.has(status) ? (firstEventAt(snapshot, MOVING) ?? now) : null),
    deliveredAt: previous.deliveredAt ?? (status === "delivered" ? (firstEventAt(snapshot, new Set(["delivered"])) ?? now) : null),
    cancelledAt: status === "cancelled" ? (previous.cancelledAt ?? now) : previous.cancelledAt,
    // A cancel that was asked for is settled either way once the provider says where it stands.
    cancelRequestedAt: status === "pickup_requested" ? previous.cancelRequestedAt : null,
    lastEventAt: maxDate(previous.lastEventAt, latest),
    lastError: null,
    updatedAt: now,
  };
}

async function insertEvents(tx: Tx, shipmentId: string, snapshot: ProviderShipment, source: ShipmentEventSource): Promise<number> {
  if (snapshot.history.length === 0) return 0;
  const rows = await tx
    .insert(shipmentEvents)
    .values(
      snapshot.history.map((entry) => ({
        shipmentId,
        occurredAt: entry.occurredAt,
        providerStatus: entry.providerStatus,
        normalizedStatus: entry.status,
        description: entry.note,
        source,
      })),
    )
    .onConflictDoNothing({ target: [shipmentEvents.shipmentId, shipmentEvents.occurredAt, shipmentEvents.providerStatus] })
    .returning({ id: shipmentEvents.id });
  return rows.length;
}

/** What changed in the shipment row, for the audit log and to skip an audit row for a read that
 * changed nothing. */
const TRACKED_COLUMNS = ["status", "providerStatus", "awb", "costAmount", "routingCode", "trackingLink", "driverName", "driverPhone", "driverPlateNumber", "providerTrackingId"] as const;

function changedColumns(previous: ShipmentRow, row: ShipmentRow): string[] {
  return TRACKED_COLUMNS.filter((column) => previous[column] !== row[column]);
}

/** Moves the order through transitionOrderStatus (a savepoint inside this transaction), or returns
 * the refusal message (the order moved on meanwhile, or the courier and resi fail the rule). */
async function moveOrder(tx: Tx, order: OrderRow, toStatus: "shipped" | "completed", details: { courier: string; trackingNumber: string } | null): Promise<string | null> {
  try {
    await transitionOrderStatus(order.id, toStatus, null, tx, details ?? {});
    return null;
  } catch (error) {
    if (error instanceof ActionError) return error.message;
    // A CHECK or constraint the move trips (our data, not an outage): a refusal like any other, so
    // the shipment's own state and events are still stored and the order is flagged for staff,
    // instead of the whole read rolling back and failing the same way on every later read.
    for (const code of ["23502", "23503", "23505", "23514"]) {
      if (isPostgresErrorCode(error, code)) return `constraint ${code}`;
    }
    throw error;
  }
}

/** Applies one provider read to a booked attempt and its order (see the module comment). Throws
 * ActionError(SHIPMENT_CHANGED_MESSAGE) when the read names another provider order or reference
 * than the stored attempt (our data and the provider's disagree; nothing is written). */
export async function applyShipmentSnapshot(db: Database, shipmentId: string, snapshot: ProviderShipment, options: ApplySnapshotOptions): Promise<ApplySnapshotResult> {
  return db.transaction(async (tx) => {
    const [ref] = await tx.select({ orderId: shipments.orderId }).from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
    if (!ref) throw new Error("shipment vanished");
    const [order] = await tx.select().from(orders).where(eq(orders.id, ref.orderId)).for("update").limit(1);
    if (!order) throw new Error("the shipment's order vanished");
    const [previous] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for("update").limit(1);
    if (!previous) throw new Error("shipment vanished under the order lock");

    const unchanged = (stale: boolean, eventsAdded: number): ApplySnapshotResult => ({
      row: previous,
      orderId: order.id,
      orderNo: order.orderNo,
      applied: false,
      stale,
      eventsAdded,
      overQuote: false,
      orderTransitions: [],
      flagsRaised: [],
    });
    const log = { shipmentId, orderNo: order.orderNo, source: options.source };

    if (options.expectBooking && previous.status !== "booking") {
      if (previous.providerOrderId === snapshot.providerOrderId) return unchanged(false, 0);
      console.error("[shipping] a booking answer names another provider order than the one stored", { ...log, referenceId: previous.referenceId });
      throw new ActionError(SHIPMENT_CHANGED_MESSAGE);
    }
    // An ended attempt stays ended: a read taken before a cancel finished must never make it live
    // again (and a newer attempt may exist by now).
    if (ENDED_SHIPMENT_STATUSES.includes(previous.status)) return unchanged(false, 0);
    if (previous.providerOrderId !== null && previous.providerOrderId !== snapshot.providerOrderId) {
      console.error("[shipping] provider answer for another order id", { ...log, referenceId: previous.referenceId });
      throw new ActionError(SHIPMENT_CHANGED_MESSAGE);
    }
    if (snapshot.referenceId !== null && snapshot.referenceId !== previous.referenceId) {
      console.error("[shipping] provider order carries another reference id than the stored attempt", { ...log, referenceId: previous.referenceId });
      throw new ActionError(SHIPMENT_CHANGED_MESSAGE);
    }

    const eventsAdded = await insertEvents(tx, shipmentId, snapshot, options.source);
    // A courier time in the future (a wrong offset) would make every later read look stale and keep
    // the shipment from ever counting as quiet: never later than a few minutes from now.
    const newest = latestEventAt(snapshot);
    const latest = newest !== null && newest.getTime() > Date.now() + FUTURE_EVENT_TOLERANCE_MS ? new Date(Date.now() + FUTURE_EVENT_TOLERANCE_MS) : newest;
    if (latest !== newest) console.warn("[shipping] courier history time in the future; clamped", { ...log });
    if (latest !== null && previous.lastEventAt !== null && latest < previous.lastEventAt) {
      console.info("[shipping] read older than the stored state; only its events were kept", { ...log, eventsAdded });
      return unchanged(true, eventsAdded);
    }

    const now = new Date();
    const [row] = await tx.update(shipments).set(snapshotFields(previous, snapshot, latest, now)).where(eq(shipments.id, shipmentId)).returning();
    if (!row) throw new Error("shipment update matched nothing under its lock");

    const moved = row.status !== previous.status;
    const providerStatusChanged = row.providerStatus !== previous.providerStatus;
    const awbChanged = row.awb !== null && row.awb !== previous.awb;
    const flags = new Set<OrderAttentionFlag>();
    const transitions: OrderStatus[] = [];
    const problem = (reason: string) => {
      flags.add("delivery_problem");
      console.warn("[shipping] delivery problem flagged", { ...log, reason, status: row.status, providerStatus: row.providerStatus });
    };

    // Price (decision 47): only when it changed, so a flag staff cleared is not raised again.
    const priceChanged = row.costAmount !== null && row.costAmount !== previous.costAmount;
    const overQuote = priceChanged && order.shippingCostAmount !== null && isShippingCostOverQuote(row.costAmount!, order.shippingCostAmount);
    if (overQuote) flags.add("shipping_cost_over_quote");
    if (row.costAmount === null && previous.status === "booking") console.warn("[shipping] booked without a known price; checked again on the next read", log);

    // Waybill: a resi that came from the booking follows a new waybill; one staff typed that differs
    // is flagged (decision 52).
    let trackingNumber: string | null = null;
    if (awbChanged && order.trackingNumber !== null && !sameResi(row.awb!, order.trackingNumber)) {
      if (previous.awb !== null && sameResi(order.trackingNumber, previous.awb)) {
        const parsed = parseShipmentDetails({ courier: order.courier ?? order.shippingCourierLabel ?? row.courier, trackingNumber: row.awb }, { checkoutOrder: true });
        if (parsed.ok && parsed.value.trackingNumber) trackingNumber = parsed.value.trackingNumber;
        else problem("new waybill fails the resi rule");
      } else {
        flags.add("tracking_number_mismatch");
      }
    }
    if (trackingNumber !== null) await tx.update(orders).set({ trackingNumber }).where(eq(orders.id, order.id));

    // Undocumented status: stored raw (the state stays), flagged, never applied.
    if (snapshot.providerStatus !== null && snapshot.knownStatus === null && providerStatusChanged) problem("undocumented status");

    // Order effects.
    let orderStatus = order.status;
    if (MOVING.has(row.status)) {
      if (orderStatus === "to_ship" && order.paymentStatus === "paid") {
        const details = parseShipmentDetails({ courier: order.shippingCourierLabel ?? row.courier.toUpperCase(), trackingNumber: row.awb }, { checkoutOrder: true });
        if (!details.ok || !details.value.courier || !details.value.trackingNumber) {
          // Retried by every later read while the shipment is still read (a delivered shipment is not
          // read again: then the delivery_problem flag is the signal for staff to ship and complete
          // it by hand); flagged once, when the state or the waybill changes.
          if (moved || awbChanged) problem(row.awb === null ? "picked up without a waybill" : "waybill fails the resi rule");
        } else {
          const refused = await moveOrder(tx, order, "shipped", { courier: details.value.courier, trackingNumber: details.value.trackingNumber });
          if (refused === null) {
            transitions.push("shipped");
            orderStatus = "shipped";
          } else if (moved || awbChanged) {
            problem(`order could not be shipped: ${refused}`);
          } else {
            console.warn("[shipping] order still not shipped by tracking (flagged earlier)", { ...log, refused });
          }
        }
      } else if (orderStatus === "to_ship") {
        // A to_ship checkout order is always paid (the payment state machine moves it there); if one
        // ever is not, a moving parcel needs staff.
        if (moved) problem("parcel moving for an order that is not paid");
      } else if ((orderStatus === "cancelled" || orderStatus === "returned" || orderStatus === "awaiting_payment") && moved) {
        problem("parcel moving for an order that is not to be shipped");
      }
    }
    if (row.status === "delivered" && orderStatus === "shipped") {
      const refused = await moveOrder(tx, order, "completed", null);
      if (refused === null) transitions.push("completed");
      else if (moved || transitions.length > 0) problem(`order could not be completed: ${refused}`);
      else console.warn("[shipping] order still not completed by tracking (flagged earlier)", { ...log, refused });
    }
    if (NEEDS_STAFF.has(row.status) && (moved || providerStatusChanged)) problem("returning, returned or held");
    // A cancel we asked for has cancel_requested_at set before the provider is called (K2).
    if (row.status === "cancelled" && moved && previous.cancelRequestedAt === null) problem("ended by the provider without a cancel from us");

    const flagsRaised = [...flags];
    if (flagsRaised.length > 0) {
      await tx.update(orders).set({ needsAttention: withAttentionFlags(flagsRaised), updatedAt: sql`now()` }).where(eq(orders.id, order.id));
    }

    const changed = changedColumns(previous, row);
    if (options.actorStaffUserId !== null || changed.length > 0 || flagsRaised.length > 0 || transitions.length > 0 || trackingNumber !== null || eventsAdded > 0) {
      await writeAuditLog(tx, {
        actorStaffUserId: options.actorStaffUserId,
        action: options.action,
        entityType: "order",
        entityId: order.id,
        before: { shipmentId, status: previous.status, awb: previous.awb, costAmount: previous.costAmount, providerStatus: previous.providerStatus },
        after: {
          shipmentId,
          referenceId: row.referenceId,
          providerOrderId: row.providerOrderId,
          status: row.status,
          awb: row.awb,
          costAmount: row.costAmount,
          providerStatus: row.providerStatus,
          source: options.source,
          eventsAdded,
          overQuote,
          flagsRaised,
          orderTransitions: transitions,
          ...(trackingNumber !== null ? { orderTrackingNumber: trackingNumber } : {}),
        },
      });
    }
    return { row, orderId: order.id, orderNo: order.orderNo, applied: true, stale: false, eventsAdded, overQuote, orderTransitions: transitions, flagsRaised };
  });
}

// ---------- reads: the webhook's re-fetch and the poller ----------

/** At most one provider read per shipment in this window (decision 48: webhooks re-fetch at most
 * once every 2 minutes per shipment). The poller claims through the same rule. */
export const SHIPMENT_READ_DEBOUNCE_SECONDS = 120;

/** What tracking needs from the provider: reads only (apps/web never books). */
export type ShipmentReader = Pick<ShipmentProvider, "name" | "getShipment">;

/** A booked attempt the tracking may still read: open, with a provider id, not in a final provider
 * status (BITESHIP_FINAL_STATUSES: the poller stops reading). */
function readableCondition() {
  return and(
    inArray(shipments.status, [...OPEN_SHIPMENT_STATUSES]),
    isNotNull(shipments.providerOrderId),
    or(sql`${shipments.providerStatus} is null`, notInArray(shipments.providerStatus, FINAL_PROVIDER_STATUSES)),
  );
}

/** Claims the next provider read of a shipment: one statement, so a webhook and a poll (or two
 * webhooks) at the same moment never both read it. Clears a pending re-fetch request (this read
 * serves it). Null when the shipment is not readable or was read in the last 2 minutes. */
export async function claimShipmentRead(db: Database, shipmentId: string): Promise<ShipmentRow | null> {
  const [row] = await db
    .update(shipments)
    .set({ lastPolledAt: sql`now()`, refetchRequestedAt: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(shipments.id, shipmentId),
        readableCondition(),
        sql`(${shipments.lastPolledAt} is null or ${shipments.lastPolledAt} < now() - make_interval(secs => ${SHIPMENT_READ_DEBOUNCE_SECONDS}))`,
      ),
    )
    .returning();
  return row ?? null;
}

/** Asks the next poll to read this shipment (a webhook arrived while its read was debounced, or the
 * read failed). False when the shipment is no longer readable (ended or final). */
async function requestRefetch(db: Database, shipmentId: string, lastError: string | null): Promise<boolean> {
  const [row] = await db
    .update(shipments)
    .set({ refetchRequestedAt: sql`coalesce(${shipments.refetchRequestedAt}, now())`, ...(lastError !== null ? { lastError } : {}), updatedAt: sql`now()` })
    .where(and(eq(shipments.id, shipmentId), readableCondition()))
    .returning({ id: shipments.id });
  return row !== undefined;
}

export type ShipmentReadOutcome =
  /** The read was applied (or was older than what is stored: only its events were kept). */
  | "applied"
  | "stale"
  /** Read in the last 2 minutes: the next poll reads it again. */
  | "debounced"
  /** Ended, final, or not booked: nothing to read. */
  | "closed"
  /** Our daily budget is used up: read again by a later poll ("try again tomorrow"). */
  | "budget_exhausted"
  /** Biteship could not be reached: read again by the next poll. */
  | "unavailable"
  /** The provider's answer or our data is wrong (not found, unreadable, another order): logged. */
  | "failed";

export interface ShipmentReadResult {
  outcome: ShipmentReadOutcome;
  /** Set when the read was applied: what it did to the order. */
  applied: ApplySnapshotResult | null;
}

/** `shipments.last_error` for a failed tracking read (shown to staff on the order page). */
function readError(reason: string): string {
  return `read:${reason}`;
}

/** `requestRefetch` that never throws (logged): a failed bookkeeping write must not abort a poll. */
async function safeRequestRefetch(db: Database, shipmentId: string, lastError: string | null): Promise<void> {
  try {
    await requestRefetch(db, shipmentId, lastError);
  } catch (error) {
    console.error("[shipping] could not ask for a re-read; the poll interval reads it later", { shipmentId, lastError, ...errorLogFields(error) });
  }
}

/** A read that will keep failing (not found, unreadable, another order, our own bad id): records why
 * on the shipment (staff see it on the order page) and, the first time this reason is seen, flags the
 * order `delivery_problem` so it does not wait for the next time someone opens it. Under the order's
 * lock, then the shipment's. Never throws (logged). */
async function recordPermanentReadError(db: Database, shipmentId: string, lastError: string): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const [ref] = await tx.select({ orderId: shipments.orderId }).from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
      if (!ref) return;
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, ref.orderId)).for("update").limit(1);
      const [changed] = await tx
        .update(shipments)
        .set({ lastError, updatedAt: sql`now()` })
        .where(and(eq(shipments.id, shipmentId), readableCondition(), sql`${shipments.lastError} is distinct from ${lastError}`))
        .returning({ orderId: shipments.orderId });
      if (!changed) return;
      await tx.update(orders).set({ needsAttention: withAttentionFlags(["delivery_problem"]), updatedAt: sql`now()` }).where(eq(orders.id, changed.orderId));
      await writeAuditLog(tx, { actorStaffUserId: null, action: "flag_tracking_read_failed", entityType: "order", entityId: changed.orderId, after: { shipmentId, lastError } });
    });
  } catch (error) {
    console.error("[shipping] could not record a tracking read error", { shipmentId, lastError, ...errorLogFields(error) });
  }
}

/** Read errors that will not go away by reading again soon (recordPermanentReadError). */
const PERMANENT_READ_ERRORS = ["read:not_found", "read:bad_response", "read:refused", "read:mismatch", "read:invalid_id"];

/** Reads one claimed shipment from the provider and applies the answer. Never throws for a provider
 * or data problem (it is the outcome, logged); a database failure while applying is logged and
 * the shipment asked to be read again. */
export async function readClaimedShipment(db: Database, reader: ShipmentReader, shipment: ShipmentRow, source: "webhook" | "poll"): Promise<ShipmentReadResult> {
  const log = { shipmentId: shipment.id, source };
  if (shipment.providerOrderId === null) {
    console.error("[shipping] tracking read of a shipment without a provider order id", log);
    return { outcome: "failed", applied: null };
  }
  let snapshot: ProviderShipment;
  try {
    snapshot = await reader.getShipment(shipment.providerOrderId);
  } catch (error) {
    if (error instanceof ShipmentProviderError) {
      if (error.reason === "budget_exhausted") {
        console.error("[shipping] daily Biteship order read budget used up; tracking reads wait until tomorrow", log);
        await safeRequestRefetch(db, shipment.id, readError("budget_exhausted"));
        return { outcome: "budget_exhausted", applied: null };
      }
      if (error.reason === "unavailable") {
        console.warn("[shipping] tracking read failed; read again by the next poll", { ...log, ...error.logFields() });
        await safeRequestRefetch(db, shipment.id, readError("unavailable"));
        return { outcome: "unavailable", applied: null };
      }
      // not_found, bad_response, refused: reading again soon will not help; the poller tries again
      // after its 6-hour interval, and staff see why on the order page.
      console.error("[shipping] tracking read failed permanently", { ...log, ...error.logFields() });
      await recordPermanentReadError(db, shipment.id, readError(error.reason));
      return { outcome: "failed", applied: null };
    }
    console.error("[shipping] tracking read failed unexpectedly", { ...log, ...errorLogFields(error) });
    if (error instanceof RangeError) await recordPermanentReadError(db, shipment.id, readError("invalid_id"));
    else await safeRequestRefetch(db, shipment.id, readError("unexpected"));
    return { outcome: "failed", applied: null };
  }
  try {
    const applied = await applyShipmentSnapshot(db, shipment.id, snapshot, { source, actorStaffUserId: null, action: source === "webhook" ? "track_shipment_webhook" : "track_shipment_poll" });
    return { outcome: applied.stale ? "stale" : "applied", applied };
  } catch (error) {
    if (error instanceof ActionError) {
      // Our data and the provider's disagree (another order or reference): logged where found.
      await recordPermanentReadError(db, shipment.id, readError("mismatch"));
      return { outcome: "failed", applied: null };
    }
    console.error("[shipping] tracking read could not be applied; read again by the next poll", { ...log, ...errorLogFields(error) });
    await safeRequestRefetch(db, shipment.id, null);
    return { outcome: "failed", applied: null };
  }
}

/** Milliseconds until this shipment's 2-minute read window ends (0 when it already has), or null when
 * it is no longer readable. Computed by the database, whose clock set `last_polled_at`. */
async function readWindowRemainingMs(db: Database, shipmentId: string): Promise<number | null> {
  const [row] = await db
    .select({
      ms: sql<number>`greatest(0, ceil(extract(epoch from (coalesce(${shipments.lastPolledAt}, now()) + make_interval(secs => ${SHIPMENT_READ_DEBOUNCE_SECONDS}) - now())) * 1000))::int`,
    })
    .from(shipments)
    .where(and(eq(shipments.id, shipmentId), readableCondition()))
    .limit(1);
  return row ? Number(row.ms) : null;
}

/** Margin past the end of the read window before the deferred read claims (clock rounding). */
const DEFERRED_READ_MARGIN_MS = 1_000;

export interface WebhookRefetchResult extends ShipmentReadResult {
  /** `fetched`: read at once. `deferred`: the post came inside another read's 2-minute window, so it
   * waited for the window to end and then read. `debounced`: still inside a window and not waiting
   * (or, after waiting, a read that started after this post already served it); the next poll reads
   * it. `none`: nothing was read (closed, or no reader). */
  fetch: "fetched" | "deferred" | "debounced" | "none";
}

export interface WebhookRefetchOptions {
  /** Waits this long (the rest of the read window) and answers true, or answers false at once to
   * not wait (another post for this shipment is already waiting: its read starts after both arrived;
   * or too many are waiting). Without it, or on false, a debounced post only asks the next poll (up
   * to 3 hours later) to read the shipment. */
  waitForReadWindow?: (ms: number, shipmentId: string) => Promise<boolean>;
}

/** The webhook's re-fetch for one shipment (decision 48): claimed (at most once every 2 minutes),
 * read, applied. A post that comes while another read's window is open (Biteship sends one post per
 * status step, seconds apart: `allocated`, `picking_up`, `picked`) is what that read could not see,
 * so with `waitForReadWindow` it waits for the window to end and reads then. Of several waiting posts
 * only one claims (the claim is one statement); for the others that read, which started after they
 * arrived, already serves them. The re-read request stays set until a read claims it, so the poll is
 * still the backstop when the process stops while waiting. */
export async function refetchShipmentForWebhook(db: Database, reader: ShipmentReader | null, shipmentId: string, options: WebhookRefetchOptions = {}): Promise<WebhookRefetchResult> {
  let claimed = await claimShipmentRead(db, shipmentId);
  let fetchMode: WebhookRefetchResult["fetch"] = "fetched";
  if (!claimed) {
    if (!(await requestRefetch(db, shipmentId, null))) return { outcome: "closed", applied: null, fetch: "none" };
    if (!options.waitForReadWindow) return { outcome: "debounced", applied: null, fetch: "debounced" };
    const remainingMs = await readWindowRemainingMs(db, shipmentId);
    if (remainingMs === null) return { outcome: "closed", applied: null, fetch: "none" };
    const waited = await options.waitForReadWindow(Math.min(remainingMs, SHIPMENT_READ_DEBOUNCE_SECONDS * 1000) + DEFERRED_READ_MARGIN_MS, shipmentId);
    if (!waited) return { outcome: "debounced", applied: null, fetch: "debounced" };
    claimed = await claimShipmentRead(db, shipmentId);
    if (!claimed) {
      // Ended or final while waiting, or another read (started after this post) served it.
      if ((await readWindowRemainingMs(db, shipmentId)) === null) return { outcome: "closed", applied: null, fetch: "none" };
      return { outcome: "debounced", applied: null, fetch: "debounced" };
    }
    fetchMode = "deferred";
  }
  if (!reader) {
    // Claimed but nothing can read it: hand it to the next poll (which will log the same problem).
    await requestRefetch(db, shipmentId, null);
    return { outcome: "unavailable", applied: null, fetch: "none" };
  }
  return { ...(await readClaimedShipment(db, reader, claimed, "webhook")), fetch: fetchMode };
}

// ---------- the poller (cron, every 3 hours) ----------

/** A shipment is read by the poller when its last event and its last read are both older than this
 * (decision 48), or always while it waits for pickup, or when a webhook asked for a re-read. */
export const SHIPMENT_POLL_INTERVAL_HOURS = 6;
/** No pickup this long after booking flags `tracking_stale` (plan status mapping). */
export const SHIPMENT_PICKUP_STALE_DAYS = 2;
/** No courier event this long on an open shipment flags `tracking_stale`. */
export const SHIPMENT_EVENT_STALE_DAYS = 5;
/** Shipments looked at per run; the rest wait for the next run (3 hours). */
const POLL_CANDIDATE_LIMIT = 100;
/** The poll stops starting reads after this long (each read times out after 10 s, retried once), so it
 * ends well inside the cron's curl limit and never overlaps the next payment sweep on the shared lock. */
const POLL_TIME_BUDGET_MS = 150_000;

export interface ShipmentPollSummary {
  candidates: number;
  read: number;
  outcomes: Partial<Record<ShipmentReadOutcome, number>>;
  /** Orders this run moved (for the emails): `shipped` / `completed`. */
  shipped: number;
  completed: number;
  /** Order numbers whose status changed this run (the caller sends what emails are due). */
  changedOrderNos: string[];
  /** Orders newly flagged tracking_stale this run. */
  staleFlagged: number;
  /** The daily read budget ran out: the remaining reads wait until tomorrow (plan K1 notes). */
  budgetExhausted: boolean;
  /** Stopped at the time budget or the candidate limit; the rest go next run. */
  truncated: boolean;
  /** No provider configured: only the stale pass ran. */
  notConfigured: boolean;
}

/** Raises `tracking_stale` (database only, no provider call): no pickup 2 days after booking, or no
 * courier event for 5 days on an open shipment. Once per quiet spell: `stale_flagged_at` must be
 * older than the shipment's newest event (or booking), so a flag staff cleared is raised again only
 * after something new happened and went quiet again. Each one under the order's lock, then the
 * shipment's (the order every writer takes). Returns the flagged order numbers. */
export async function flagStaleShipments(db: Database): Promise<string[]> {
  const quietSince = sql`coalesce(${shipments.lastEventAt}, ${shipments.bookedAt}, ${shipments.createdAt})`;
  const staleCondition = and(
    readableCondition(),
    or(
      and(eq(shipments.status, "pickup_requested"), sql`${shipments.bookedAt} < now() - make_interval(days => ${SHIPMENT_PICKUP_STALE_DAYS})`),
      sql`${quietSince} < now() - make_interval(days => ${SHIPMENT_EVENT_STALE_DAYS})`,
    ),
    sql`(${shipments.staleFlaggedAt} is null or ${shipments.staleFlaggedAt} < ${quietSince})`,
  );
  // Only orders still on their way: one staff already completed, returned or cancelled is not stale.
  const candidates = await db
    .select({ id: shipments.id, orderId: shipments.orderId })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(and(staleCondition, inArray(orders.status, ["to_ship", "shipped"])))
    .limit(POLL_CANDIDATE_LIMIT);
  const flagged: string[] = [];
  for (const candidate of candidates) {
    try {
      const orderNo = await db.transaction(async (tx) => {
        const [order] = await tx.select({ id: orders.id, orderNo: orders.orderNo }).from(orders).where(eq(orders.id, candidate.orderId)).for("update").limit(1);
        if (!order) return null;
        // Re-checked under the locks: a read that landed meanwhile may have ended the quiet spell.
        const [marked] = await tx
          .update(shipments)
          .set({ staleFlaggedAt: sql`now()`, updatedAt: sql`now()` })
          .where(and(eq(shipments.id, candidate.id), staleCondition))
          .returning({ id: shipments.id, status: shipments.status, providerStatus: shipments.providerStatus, lastEventAt: shipments.lastEventAt });
        if (!marked) return null;
        await tx.update(orders).set({ needsAttention: withAttentionFlags(["tracking_stale"]), updatedAt: sql`now()` }).where(eq(orders.id, order.id));
        await writeAuditLog(tx, {
          actorStaffUserId: null,
          action: "flag_tracking_stale",
          entityType: "order",
          entityId: order.id,
          after: { shipmentId: marked.id, status: marked.status, providerStatus: marked.providerStatus, lastEventAt: marked.lastEventAt },
        });
        return order.orderNo;
      });
      if (orderNo) {
        console.warn("[shipping] tracking stale: no pickup or no courier event for days", { shipmentId: candidate.id, orderNo });
        flagged.push(orderNo);
      }
    } catch (error) {
      console.error("[shipping] could not flag a stale shipment; tried again next run", { shipmentId: candidate.id, ...errorLogFields(error) });
    }
  }
  return flagged;
}

/** One poll run (decision 48). The caller holds the cron run lock. Flags stale shipments first (no
 * provider call), then reads, within the shared daily budget: shipments a webhook asked to re-read,
 * then every one still waiting for pickup, then any other open one whose last event and last read
 * are both older than 6 hours, oldest read first. Each read is claimed like a webhook's (never two
 * reads of one shipment within 2 minutes). Stops at the first `budget_exhausted` (the rest are
 * marked so staff see why) or the time budget. */
export async function pollShipments(db: Database, reader: ShipmentReader | null, options: { limit?: number; timeBudgetMs?: number } = {}): Promise<ShipmentPollSummary> {
  const summary: ShipmentPollSummary = {
    candidates: 0,
    read: 0,
    outcomes: {},
    shipped: 0,
    completed: 0,
    changedOrderNos: [],
    staleFlagged: 0,
    budgetExhausted: false,
    truncated: false,
    notConfigured: reader === null,
  };
  summary.staleFlagged = (await flagStaleShipments(db)).length;
  if (!reader) return summary;

  const limit = options.limit ?? POLL_CANDIDATE_LIMIT;
  const deadline = Date.now() + (options.timeBudgetMs ?? POLL_TIME_BUDGET_MS);
  const interval = sql`make_interval(hours => ${SHIPMENT_POLL_INTERVAL_HOURS})`;
  const due = await db
    .select({ id: shipments.id })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(
      and(
        readableCondition(),
        // Staff already completed the order ("Tandai selesai", K4, owner 2026-10-22): the poll stops
        // spending the daily budget on it; a webhook still reads it (and its re-read request below).
        or(isNotNull(shipments.refetchRequestedAt), sql`${orders.status} <> 'completed'`),
        or(
          isNotNull(shipments.refetchRequestedAt),
          // Waiting for pickup: every run, unless its reads keep failing for good (then the 6-hour
          // interval below, so one broken shipment does not spend the budget every 3 hours).
          and(eq(shipments.status, "pickup_requested"), or(sql`${shipments.lastError} is null`, notInArray(shipments.lastError, PERMANENT_READ_ERRORS))),
          and(
            sql`coalesce(${shipments.lastEventAt}, ${shipments.bookedAt}, ${shipments.createdAt}) < now() - ${interval}`,
            sql`(${shipments.lastPolledAt} is null or ${shipments.lastPolledAt} < now() - ${interval})`,
          ),
        ),
      ),
    )
    .orderBy(desc(isNotNull(shipments.refetchRequestedAt)), desc(sql`${shipments.status} = 'pickup_requested'`), sql`${shipments.lastPolledAt} asc nulls first`, asc(shipments.createdAt))
    .limit(limit + 1);
  summary.truncated = due.length > limit;
  const batch = due.slice(0, limit);
  summary.candidates = batch.length;

  const changed = new Set<string>();
  for (const [index, candidate] of batch.entries()) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      break;
    }
    let result: ShipmentReadResult;
    try {
      const claimed = await claimShipmentRead(db, candidate.id);
      if (!claimed) {
        summary.outcomes.debounced = (summary.outcomes.debounced ?? 0) + 1;
        continue;
      }
      summary.read += 1;
      result = await readClaimedShipment(db, reader, claimed, "poll");
    } catch (error) {
      // One shipment's database trouble never ends the run (the others, and the emails of the orders
      // already moved, still go through).
      console.error("[shipping] poll could not handle a shipment; tried again next run", { shipmentId: candidate.id, ...errorLogFields(error) });
      summary.outcomes.failed = (summary.outcomes.failed ?? 0) + 1;
      continue;
    }
    summary.outcomes[result.outcome] = (summary.outcomes[result.outcome] ?? 0) + 1;
    if (result.applied && result.applied.orderTransitions.length > 0) {
      changed.add(result.applied.orderNo);
      if (result.applied.orderTransitions.includes("shipped")) summary.shipped += 1;
      if (result.applied.orderTransitions.includes("completed")) summary.completed += 1;
    }
    if (result.outcome === "budget_exhausted") {
      summary.budgetExhausted = true;
      // The ones this run will not reach: staff see why on the order page, and they come first next run.
      const rest = batch.slice(index + 1).map((row) => row.id);
      if (rest.length > 0) {
        try {
          await db
            .update(shipments)
            .set({ lastError: readError("budget_exhausted"), refetchRequestedAt: sql`coalesce(${shipments.refetchRequestedAt}, now())`, updatedAt: sql`now()` })
            .where(and(inArray(shipments.id, rest), readableCondition()));
        } catch (error) {
          console.error("[shipping] could not mark the shipments the poll did not reach", { count: rest.length, ...errorLogFields(error) });
        }
      }
      break;
    }
  }
  summary.changedOrderNos = [...changed];
  if (summary.truncated) console.warn("[shipping] poll did not reach every due shipment; the rest go next run", { candidates: summary.candidates, read: summary.read });
  return summary;
}
