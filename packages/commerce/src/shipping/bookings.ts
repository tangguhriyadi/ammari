import "server-only";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { orderItems, orders, shipments, type ShipmentStatus } from "@ammari/db/schema";
import { writeAuditLog, type Database, type Tx } from "../db";
import { ActionError, errorLogFields, isPostgresConstraintViolation } from "../errors";
import type { ShipmentRuntime } from "./shipment-config";
import { ShipmentProviderError, type CreateShipmentInput, type ProviderShipment, type ShipmentCancelReasonCode } from "./shipment-provider";
import { SHIPMENT_MAX_ATTEMPTS, shipmentReferenceId } from "./shipment-rules";
import { ENDED_SHIPMENT_STATUSES, SHIPMENT_CHANGED_MESSAGE, applyShipmentSnapshot } from "./tracking";

// Courier booking for staff (docs/plans/cart-checkout.md §15 Phase K, K2; decisions 46 to 51).
//
// Never a double booking:
// - One live attempt per order, enforced by the database (shipments_live_order_id_key) and taken
//   under the order's row lock, so two "Pesan kurir" at once reserve one attempt; the other sees it.
// - The provider is called outside any transaction, with the attempt's own reference id. Biteship
//   refuses a repeated reference (40002060), so re-sending the same attempt can never book twice.
// - Any answer that may hide a booking (timeout, network error, 5xx, an unreadable answer: the
//   client's `outcomeUnknown`) keeps the attempt `booking`; only a clear refusal of the FIRST send
//   ends it `failed`. "Cek ulang pemesanan" re-sends the same reference: booked now, or the
//   duplicate is adopted after reading the order named in the error, only when its reference is
//   ours. A re-send is never trusted to end the attempt (a refusal then could hide the first
//   booking, e.g. a balance check after the money was spent): such an attempt stays "perlu dicek
//   manual" and staff ship through the manual resi path.
// - A cancel is allowed only before pickup; a lost or "not cancellable" answer is checked by
//   reading the order before staff are told anything. A cancelled attempt ends and a new attempt
//   may follow.
// Every read of a booked attempt goes through the tracking rules (./tracking.ts, K3): a read that
// finds the parcel picked up or delivered moves the order like the webhook and the poller do. Every
// change writes an audit_log row with the staff actor. Logs carry reasons, codes and our own ids only, never the
// recipient's name, phone or address.

export const SHIPMENT_MESSAGES = {
  notFound: "Pesanan tidak ditemukan.",
  notCheckout: "Kurir hanya bisa dipesan dari sini untuk pesanan checkout website.",
  notReady: "Kurir bisa dipesan setelah pesanan dibayar dan berstatus Siap Kirim.",
  noQuote: "Pesanan ini tidak punya data ongkir, jadi kurir tidak bisa dipesan dari sini. Pesan kurir manual, lalu isi nomor resi.",
  noAddress: "Alamat pesanan tidak lengkap, jadi kurir tidak bisa dipesan dari sini. Pesan kurir manual, lalu isi nomor resi.",
  invalidData: "Data pesanan ditolak sebelum dikirim ke kurir (nomor HP atau alamat). Pesan kurir manual, lalu isi nomor resi.",
  noProvider: "Pemesanan kurir belum dikonfigurasi di admin. Pesan kurir manual, lalu isi nomor resi.",
  tooManyAttempts: "Pesanan ini sudah terlalu sering dipesankan kurir. Pesan kurir manual, lalu isi nomor resi.",
  refused: "Biteship menolak pemesanan ini. Kurir belum dipesan. Pesan kurir manual, lalu isi nomor resi.",
  balance: "Saldo Biteship tidak cukup. Kurir belum dipesan. Isi saldo dulu, lalu pesan lagi.",
  inactiveKey: "Akun Biteship belum aktif untuk pemesanan kurir. Kurir belum dipesan. Hubungi pemilik.",
  unavailable: "Biteship belum bisa dihubungi. Kurir belum dipesan. Coba lagi sebentar lagi.",
  budget: "Batas harian pemakaian Biteship sudah tercapai. Coba lagi besok, atau pesan kurir manual.",
  recheckUnavailable: "Biteship belum bisa dihubungi, jadi pemesanan belum bisa dicek. Coba lagi sebentar lagi.",
  noBooking: "Tidak ada pemesanan kurir yang aktif untuk pesanan ini.",
  notBookedYet: "Pemesanan kurir belum pasti. Tekan Cek ulang pemesanan dulu.",
  pastPickup: "Pengiriman tidak bisa dibatalkan lagi: paket sudah dijemput kurir.",
  notCancellable: "Pengiriman dengan status ini tidak bisa dibatalkan.",
  cancelUnknown: "Pembatalan belum pasti. Tekan Cek ulang pemesanan sebentar lagi.",
  cancelUnavailable: "Biteship belum bisa dihubungi. Pengiriman belum dibatalkan. Coba lagi sebentar lagi.",
  cancelRefused: "Biteship menolak pembatalan ini. Pengiriman belum dibatalkan. Cek di dashboard Biteship.",
  changed: SHIPMENT_CHANGED_MESSAGE,
  providerFault: "Biteship tidak bisa memberi status pengiriman ini. Cek di dashboard Biteship.",
  cancelProviderFault: "Biteship tidak bisa memproses pembatalan ini. Pengiriman belum dibatalkan. Cek di dashboard Biteship.",
} as const;

/** Biteship refusals with their own words for staff (K1 notes): balance and an inactive key. */
const BALANCE_CODES = new Set([40002039, 40009003]);
const INACTIVE_KEY_CODE = 40002002;

const ENDED: ShipmentStatus[] = [...ENDED_SHIPMENT_STATUSES];

export type ShipmentActionOutcome =
  /** The provider has the booking (booked now, recovered, or refreshed). */
  | { outcome: "booked"; shipmentId: string; awb: string | null; costAmount: number | null; overQuote: boolean }
  /** Another press or staff member got there first: a booked attempt already exists. */
  | { outcome: "already_booked"; shipmentId: string }
  /** The answer is not known yet: "Cek ulang pemesanan". `manualCheck`: it cannot be recovered
   * automatically; staff look the reference up in Biteship's dashboard. */
  | { outcome: "pending"; shipmentId: string; referenceId: string; manualCheck: boolean }
  /** cancelShipment only. */
  | { outcome: "cancelled"; shipmentId: string };

type ShipmentRow = typeof shipments.$inferSelect;
type OrderRow = typeof orders.$inferSelect;

/** Short, safe text for `shipments.last_error`: reason and provider code, never a body. */
function errorCode(error: ShipmentProviderError): string {
  return `${error.reason}${error.providerCode !== undefined ? `:${error.providerCode}` : error.status !== undefined ? `:http${error.status}` : ""}${error.outcomeUnknown ? ":unknown" : ""}`;
}

function refusalMessage(error: ShipmentProviderError): string {
  if (error.reason === "budget_exhausted") return SHIPMENT_MESSAGES.budget;
  if (error.reason === "refused") {
    if (error.providerCode !== undefined && BALANCE_CODES.has(error.providerCode)) return SHIPMENT_MESSAGES.balance;
    if (error.providerCode === INACTIVE_KEY_CODE) return SHIPMENT_MESSAGES.inactiveKey;
    return SHIPMENT_MESSAGES.refused;
  }
  return SHIPMENT_MESSAGES.unavailable;
}

export { sameResi } from "./tracking";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

async function lockOrder(tx: Tx, orderId: string): Promise<OrderRow> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
  if (!order) throw new ActionError(SHIPMENT_MESSAGES.notFound);
  return order;
}

async function liveShipment(db: Database, orderId: string, lock = false): Promise<ShipmentRow | null> {
  const query = db
    .select()
    .from(shipments)
    .where(and(eq(shipments.orderId, orderId), notInArray(shipments.status, ENDED)))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row ?? null;
}

/** The booking request for one attempt, from the order as it is stored: the locked quote's courier
 * and service, the destination area and the address snapshot (recipient, phone, street line,
 * courier note; never the buyer's email), and one "Pakaian" item with the goods value and the
 * quoted parcel weight (plan §4.5.3), so the booked price matches the quote. */
async function bookingInput(db: Database, order: OrderRow, runtime: ShipmentRuntime, referenceId: string): Promise<CreateShipmentInput> {
  if (!order.shippingCourierCode || !order.shippingServiceCode || !order.shippingDestinationId || !order.shippingWeightGrams) {
    throw new ActionError(SHIPMENT_MESSAGES.noQuote);
  }
  const snapshot = (order.shippingAddressSnapshot ?? {}) as Record<string, unknown>;
  const name = text(snapshot.recipientName);
  const phone = text(snapshot.phone);
  const address = text(snapshot.addressLine);
  if (!name || !phone || !address) throw new ActionError(SHIPMENT_MESSAGES.noAddress);
  const [pieces] = await db.select({ count: sql<number>`coalesce(sum(${orderItems.qty}), 0)::int` }).from(orderItems).where(eq(orderItems.orderId, order.id));
  if (!pieces || pieces.count <= 0 || order.subtotalAmount <= 0) throw new ActionError(SHIPMENT_MESSAGES.noAddress);
  return {
    referenceId,
    origin: { ...runtime.origin },
    destination: { name, phone, address, areaId: order.shippingDestinationId, note: text(snapshot.notes) },
    courierCode: order.shippingCourierCode,
    serviceCode: order.shippingServiceCode,
    item: { name: "Pakaian", value: order.subtotalAmount, weightGrams: order.shippingWeightGrams, quantity: 1 },
  };
}

function assertBookable(order: OrderRow): void {
  if (order.paymentStatus === null) throw new ActionError(SHIPMENT_MESSAGES.notCheckout);
  if (order.status !== "to_ship" || order.paymentStatus !== "paid") throw new ActionError(SHIPMENT_MESSAGES.notReady);
}

/** Writes what the provider says onto the attempt through the tracking rules (./tracking.ts: events,
 * order effects, the over-quote and waybill flags), as a staff read. */
async function applyProviderShipment(
  db: Database,
  shipmentId: string,
  shipment: ProviderShipment,
  options: { expectBooking: boolean; actorStaffUserId: string | null; action: string },
): Promise<{ row: ShipmentRow; overQuote: boolean }> {
  const result = await applyShipmentSnapshot(db, shipmentId, shipment, { source: "staff", ...options });
  return { row: result.row, overQuote: result.overQuote };
}

async function recordStillBooking(db: Database, shipmentId: string, lastError: string): Promise<void> {
  await db
    .update(shipments)
    .set({ lastError, updatedAt: new Date() })
    .where(and(eq(shipments.id, shipmentId), eq(shipments.status, "booking")));
}

/** Ends the attempt `failed`; false when it was no longer an unanswered booking (a concurrent Cek
 * ulang settled it meanwhile). */
async function recordFailed(db: Database, shipment: { id: string; orderId: string; referenceId: string }, lastError: string, actorStaffUserId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(shipments)
      .set({ status: "failed", failedAt: new Date(), lastError, updatedAt: new Date() })
      .where(and(eq(shipments.id, shipment.id), eq(shipments.status, "booking"), sql`${shipments.providerOrderId} is null`))
      .returning({ id: shipments.id });
    if (!row) return false;
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "shipment_booking_failed",
      entityType: "order",
      entityId: shipment.orderId,
      after: { shipmentId: shipment.id, referenceId: shipment.referenceId, lastError },
    });
    return true;
  });
}

/** A refusal arrived for an attempt someone else settled meanwhile: report what is stored now,
 * never "not booked". */
async function outcomeOfSettledAttempt(db: Database, shipment: { id: string; referenceId: string }): Promise<ShipmentActionOutcome> {
  const [row] = await db.select().from(shipments).where(eq(shipments.id, shipment.id)).limit(1);
  console.error("[shipping] refusal for an attempt that was settled meanwhile", { shipmentId: shipment.id, status: row?.status });
  if (row && row.status !== "booking" && !ENDED.includes(row.status)) return { outcome: "already_booked", shipmentId: row.id };
  return pending(shipment, true);
}

/** Stores a booking the provider has, or, when that write fails, keeps the attempt open (the
 * re-send recovers it as a duplicate) and logs our ids so it can be reconciled. Never lets a
 * booking that exists read as "not booked". */
async function settleBooked(
  db: Database,
  shipment: { id: string; referenceId: string },
  booked: ProviderShipment,
  actorStaffUserId: string,
): Promise<ShipmentActionOutcome> {
  let settled: { row: ShipmentRow; overQuote: boolean };
  try {
    settled = await applyProviderShipment(db, shipment.id, booked, { expectBooking: true, actorStaffUserId, action: "book_shipment" });
  } catch (error) {
    console.error("[shipping] booked at the provider but not stored; kept as booking for Cek ulang", {
      shipmentId: shipment.id,
      referenceId: shipment.referenceId,
      providerOrderId: booked.providerOrderId,
      ...(error instanceof ActionError ? { message: error.message } : errorLogFields(error)),
    });
    await recordStillBooking(db, shipment.id, "apply_failed").catch(() => undefined);
    return pending(shipment, false);
  }
  if (settled.row.status === "cancelled") return { outcome: "cancelled", shipmentId: shipment.id };
  return { outcome: "booked", shipmentId: shipment.id, awb: settled.row.awb, costAmount: settled.row.costAmount, overQuote: settled.overQuote };
}

function pending(shipment: { id: string; referenceId: string }, manualCheck: boolean): ShipmentActionOutcome {
  return { outcome: "pending", shipmentId: shipment.id, referenceId: shipment.referenceId, manualCheck };
}

/** Sends one attempt's booking and settles what the answer allows. `firstSend`: only the first send
 * of an attempt may end it `failed` on a clear refusal (see the module comment). */
async function sendBooking(
  db: Database,
  runtime: ShipmentRuntime,
  shipment: { id: string; orderId: string; referenceId: string },
  input: CreateShipmentInput,
  actorStaffUserId: string,
  firstSend: boolean,
): Promise<ShipmentActionOutcome> {
  let booked: ProviderShipment;
  try {
    booked = await runtime.provider.createShipment(input);
  } catch (error) {
    if (error instanceof ShipmentProviderError) {
      const code = errorCode(error);
      console.warn("[shipping] booking not confirmed", { shipmentId: shipment.id, referenceId: shipment.referenceId, firstSend, ...error.logFields() });
      if (error.reason === "duplicate_reference") return recoverDuplicate(db, runtime, shipment, error, actorStaffUserId);
      if (!error.outcomeUnknown && (error.reason === "refused" || error.reason === "unavailable" || error.reason === "budget_exhausted")) {
        if (firstSend) {
          if (!(await recordFailed(db, shipment, code, actorStaffUserId))) return outcomeOfSettledAttempt(db, shipment);
          throw new ActionError(refusalMessage(error));
        }
        await recordStillBooking(db, shipment.id, code);
        if (error.reason === "refused") return pending(shipment, true);
        throw new ActionError(error.reason === "budget_exhausted" ? SHIPMENT_MESSAGES.budget : SHIPMENT_MESSAGES.recheckUnavailable);
      }
      await recordStillBooking(db, shipment.id, code);
      return pending(shipment, false);
    }
    if (error instanceof RangeError && firstSend) {
      // Our own data failed the client's checks before anything was sent.
      console.error("[shipping] booking request refused by our own checks", { shipmentId: shipment.id, ...errorLogFields(error) });
      if (!(await recordFailed(db, shipment, "invalid_data", actorStaffUserId))) return outcomeOfSettledAttempt(db, shipment);
      throw new ActionError(SHIPMENT_MESSAGES.invalidData);
    }
    if (error instanceof RangeError) {
      // On a re-send our own data fails the client's checks: it will never succeed by pressing again.
      console.error("[shipping] booking re-send refused by our own checks; needs a manual check", { shipmentId: shipment.id, ...errorLogFields(error) });
      await recordStillBooking(db, shipment.id, "invalid_data");
      return pending(shipment, true);
    }
    // Anything else may have happened after the request left: keep the attempt open.
    console.error("[shipping] booking failed unexpectedly; kept as booking", { shipmentId: shipment.id, ...errorLogFields(error) });
    await recordStillBooking(db, shipment.id, "unexpected");
    return pending(shipment, false);
  }
  return settleBooked(db, shipment, booked, actorStaffUserId);
}

/** 40002060: the reference already booked an order. Adopted only when the order named in the error
 * carries our reference id (K1 notes); otherwise it stays `booking` for a manual check. */
async function recoverDuplicate(
  db: Database,
  runtime: ShipmentRuntime,
  shipment: { id: string; orderId: string; referenceId: string },
  error: ShipmentProviderError,
  actorStaffUserId: string,
): Promise<ShipmentActionOutcome> {
  if (!error.existingOrderId) {
    await recordStillBooking(db, shipment.id, "duplicate_reference:no_order_id");
    return pending(shipment, true);
  }
  let existing: ProviderShipment;
  try {
    existing = await runtime.provider.getShipment(error.existingOrderId);
  } catch (readError) {
    console.warn("[shipping] duplicate booking could not be read", { shipmentId: shipment.id, ...(readError instanceof ShipmentProviderError ? readError.logFields() : errorLogFields(readError)) });
    await recordStillBooking(db, shipment.id, readError instanceof ShipmentProviderError ? `duplicate_reference:read_${readError.reason}` : "duplicate_reference:read_failed");
    return pending(shipment, false);
  }
  if (existing.referenceId !== shipment.referenceId) {
    console.error("[shipping] duplicate reference names an order with another reference id", { shipmentId: shipment.id, referenceId: shipment.referenceId });
    await recordStillBooking(db, shipment.id, "duplicate_reference:other_reference");
    return pending(shipment, true);
  }
  return settleBooked(db, shipment, existing, actorStaffUserId);
}

/** "Pesan kurir" (orders.manage): books the order's quoted courier service for a paid web order in
 * `to_ship` that has no live shipment. Refusals throw ActionError with an Indonesian message. */
export async function bookShipment(db: Database, runtime: ShipmentRuntime | null, orderId: string, actorStaffUserId: string): Promise<ShipmentActionOutcome> {
  if (!runtime) throw new ActionError(SHIPMENT_MESSAGES.noProvider);
  let reserved: { kind: "existing"; row: ShipmentRow } | { kind: "reserved"; row: ShipmentRow; input: CreateShipmentInput };
  try {
    reserved = await db.transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      assertBookable(order);
      const live = await liveShipment(tx, orderId);
      if (live) return { kind: "existing" as const, row: live };
      const [last] = await tx.select({ attempt: shipments.attempt }).from(shipments).where(eq(shipments.orderId, orderId)).orderBy(desc(shipments.attempt)).limit(1);
      const attempt = (last?.attempt ?? 0) + 1;
      if (attempt > SHIPMENT_MAX_ATTEMPTS) throw new ActionError(SHIPMENT_MESSAGES.tooManyAttempts);
      const referenceId = shipmentReferenceId(runtime.referencePrefix, order.orderNo, attempt);
      const input = await bookingInput(tx, order, runtime, referenceId);
      const [row] = await tx
        .insert(shipments)
        .values({
          orderId,
          attempt,
          referenceId,
          provider: "biteship",
          courier: input.courierCode,
          service: input.serviceCode,
          status: "booking",
          bookedByStaffUserId: actorStaffUserId,
        })
        .returning();
      if (!row) throw new Error("shipment insert returned nothing");
      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "request_shipment_booking",
        entityType: "order",
        entityId: orderId,
        after: { shipmentId: row.id, attempt, referenceId, courier: input.courierCode, service: input.serviceCode },
      });
      return { kind: "reserved" as const, row, input };
    });
  } catch (error) {
    // Defense in depth: the order lock already serializes bookings, but the database has the last word.
    if (isPostgresConstraintViolation(error, "23505", ["shipments_live_order_id_key"])) {
      const live = await liveShipment(db, orderId);
      if (live) return live.status === "booking" ? pending(live, false) : { outcome: "already_booked", shipmentId: live.id };
    }
    if (error instanceof RangeError) {
      console.error("[shipping] booking reference could not be built", { orderId, ...errorLogFields(error) });
      throw new ActionError(SHIPMENT_MESSAGES.invalidData);
    }
    throw error;
  }
  if (reserved.kind === "existing") {
    return reserved.row.status === "booking" ? pending(reserved.row, false) : { outcome: "already_booked", shipmentId: reserved.row.id };
  }
  return sendBooking(db, runtime, reserved.row, reserved.input, actorStaffUserId, true);
}

/** "Cek ulang pemesanan": for an attempt whose answer is unknown, re-sends the same reference
 * (booked now, or the duplicate recovered); for a booked one, reads it again (status, waybill,
 * price, driver; also settles a cancel whose answer was lost). */
export async function recheckBooking(db: Database, runtime: ShipmentRuntime | null, orderId: string, actorStaffUserId: string): Promise<ShipmentActionOutcome> {
  if (!runtime) throw new ActionError(SHIPMENT_MESSAGES.noProvider);
  const live = await liveShipment(db, orderId);
  if (!live) throw new ActionError(SHIPMENT_MESSAGES.noBooking);
  if (live.status !== "booking") return refreshShipment(db, runtime, live, actorStaffUserId);
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new ActionError(SHIPMENT_MESSAGES.notFound);
  // Shipped by hand or cancelled meanwhile: a re-send could book a second parcel. Only a manual look
  // at the reference can tell whether the first send booked one.
  if (order.status !== "to_ship" || order.paymentStatus !== "paid") {
    console.warn("[shipping] booking left unsettled: the order moved on, so it is not re-sent", { shipmentId: live.id, orderStatus: order.status });
    await recordStillBooking(db, live.id, "order_moved_on");
    return pending(live, true);
  }
  const input = await bookingInput(db, order, runtime, live.referenceId);
  if (input.courierCode !== live.courier || input.serviceCode !== live.service) {
    console.error("[shipping] stored attempt and order quote disagree", { shipmentId: live.id });
    throw new ActionError(SHIPMENT_MESSAGES.changed);
  }
  return sendBooking(db, runtime, live, input, actorStaffUserId, false);
}

/** Reads a booked attempt from the provider and stores what it says. */
async function refreshShipment(db: Database, runtime: ShipmentRuntime, live: ShipmentRow, actorStaffUserId: string | null): Promise<ShipmentActionOutcome> {
  if (!live.providerOrderId) {
    console.error("[shipping] booked shipment without a provider order id", { shipmentId: live.id, status: live.status });
    throw new ActionError(SHIPMENT_MESSAGES.providerFault);
  }
  let current: ProviderShipment;
  try {
    current = await runtime.provider.getShipment(live.providerOrderId);
  } catch (error) {
    if (error instanceof ShipmentProviderError) {
      if (error.reason === "budget_exhausted") throw new ActionError(SHIPMENT_MESSAGES.budget);
      if (error.reason === "unavailable") {
        console.warn("[shipping] shipment read failed", { shipmentId: live.id, ...error.logFields() });
        throw new ActionError(SHIPMENT_MESSAGES.recheckUnavailable);
      }
      // not_found, refused, bad_response: pressing again will not help.
      console.error("[shipping] shipment read failed permanently", { shipmentId: live.id, ...error.logFields() });
      throw new ActionError(SHIPMENT_MESSAGES.providerFault);
    }
    throw error;
  }
  const settled = await applyProviderShipment(db, live.id, current, { expectBooking: false, actorStaffUserId, action: "refresh_shipment" });
  if (settled.row.status === "cancelled") return { outcome: "cancelled", shipmentId: live.id };
  return { outcome: "booked", shipmentId: live.id, awb: settled.row.awb, costAmount: settled.row.costAmount, overQuote: settled.overQuote };
}

/** Before printing a label: the routing code and a waybill change only arrive with a read, so a
 * booked attempt without a routing code is read once (best effort: the label prints without one). */
/** Returns false when a read was needed but failed (the label then carries a warning). */
export async function refreshShipmentForLabel(db: Database, runtime: ShipmentRuntime | null, shipmentId: string): Promise<boolean> {
  if (!runtime) return false;
  const [row] = await db.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
  if (!row || row.routingCode !== null || !row.providerOrderId || ENDED.includes(row.status)) return true;
  try {
    await refreshShipment(db, runtime, row, null);
    return true;
  } catch (error) {
    console.warn("[shipping] label refresh failed; printing with what is stored", { shipmentId, ...(error instanceof ActionError ? { message: error.message } : errorLogFields(error)) });
    return false;
  }
}

export const SHIPMENT_CANCEL_REASON_CODES: readonly ShipmentCancelReasonCode[] = ["change_courier", "pickup_delay", "change_address", "others"];

/** "Batalkan pengiriman" (orders.manage), only before pickup. The attempt ends `cancelled` and the
 * order can be booked again; the order itself stays `to_ship`. */
export async function cancelShipment(
  db: Database,
  runtime: ShipmentRuntime | null,
  orderId: string,
  input: { reasonCode: ShipmentCancelReasonCode },
  actorStaffUserId: string,
): Promise<ShipmentActionOutcome> {
  if (!runtime) throw new ActionError(SHIPMENT_MESSAGES.noProvider);
  const live = await db.transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const row = await liveShipment(tx, orderId, true);
    if (!row) throw new ActionError(SHIPMENT_MESSAGES.noBooking);
    if (row.status === "booking") throw new ActionError(SHIPMENT_MESSAGES.notBookedYet);
    if (row.status !== "pickup_requested") throw new ActionError(row.pickedUpAt || row.status === "picked_up" || row.status === "in_transit" ? SHIPMENT_MESSAGES.pastPickup : SHIPMENT_MESSAGES.notCancellable);
    if (!row.providerOrderId) {
      console.error("[shipping] booked shipment without a provider order id", { shipmentId: row.id });
      throw new ActionError(SHIPMENT_MESSAGES.providerFault);
    }
    const [updated] = await tx
      .update(shipments)
      .set({ cancelRequestedAt: new Date(), cancelledByStaffUserId: actorStaffUserId, updatedAt: new Date() })
      .where(eq(shipments.id, row.id))
      .returning();
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "request_shipment_cancel",
      entityType: "order",
      entityId: orderId,
      after: { shipmentId: row.id, referenceId: row.referenceId, reasonCode: input.reasonCode },
    });
    return updated!;
  });

  try {
    await runtime.provider.cancelShipment(live.providerOrderId!, { reasonCode: input.reasonCode, reason: input.reasonCode === "others" ? "Dibatalkan penjual" : null });
  } catch (error) {
    if (!(error instanceof ShipmentProviderError)) {
      console.error("[shipping] cancel failed unexpectedly; checking the order", { shipmentId: live.id, ...errorLogFields(error) });
      return settleCancelByReading(db, runtime, live, actorStaffUserId, "unknown");
    }
    console.warn("[shipping] cancel not confirmed", { shipmentId: live.id, ...error.logFields() });
    if (error.reason === "not_cancellable" || error.outcomeUnknown) return settleCancelByReading(db, runtime, live, actorStaffUserId, error.reason === "not_cancellable" ? "not_cancellable" : "unknown");
    // Nothing was cancelled: the request is withdrawn.
    await db
      .update(shipments)
      .set({ cancelRequestedAt: null, lastError: errorCode(error), updatedAt: new Date() })
      .where(and(eq(shipments.id, live.id), eq(shipments.status, "pickup_requested")));
    if (error.reason === "refused") throw new ActionError(SHIPMENT_MESSAGES.cancelRefused);
    if (error.reason === "budget_exhausted") throw new ActionError(SHIPMENT_MESSAGES.budget);
    if (error.reason === "unavailable") throw new ActionError(SHIPMENT_MESSAGES.cancelUnavailable);
    console.error("[shipping] cancel failed permanently", { shipmentId: live.id, ...error.logFields() });
    throw new ActionError(SHIPMENT_MESSAGES.cancelProviderFault);
  }
  return settleCancelled(db, live.id, actorStaffUserId);
}

async function settleCancelled(db: Database, shipmentId: string, actorStaffUserId: string | null): Promise<ShipmentActionOutcome> {
  return db.transaction(async (tx) => {
    const [ref] = await tx.select({ orderId: shipments.orderId }).from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
    if (!ref) throw new Error("shipment vanished");
    await lockOrder(tx, ref.orderId);
    const [previous] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for("update").limit(1);
    if (!previous) throw new Error("shipment vanished under the order lock");
    if (previous.status === "cancelled") return { outcome: "cancelled" as const, shipmentId };
    const [row] = await tx
      .update(shipments)
      .set({ status: "cancelled", providerStatus: "cancelled", cancelledAt: new Date(), cancelRequestedAt: null, lastError: null, updatedAt: new Date() })
      .where(eq(shipments.id, shipmentId))
      .returning();
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "cancel_shipment",
      entityType: "order",
      entityId: ref.orderId,
      before: { shipmentId, status: previous.status, providerStatus: previous.providerStatus },
      after: { shipmentId, referenceId: row!.referenceId, status: row!.status },
    });
    return { outcome: "cancelled" as const, shipmentId };
  });
}

/** After a lost answer or 40002053: a cancel that worked but lost its answer is re-answered "not
 * cancellable", so the order is read before staff are told anything (K1 notes). */
async function settleCancelByReading(
  db: Database,
  runtime: ShipmentRuntime,
  live: ShipmentRow,
  actorStaffUserId: string,
  why: "not_cancellable" | "unknown",
): Promise<ShipmentActionOutcome> {
  let current: ProviderShipment;
  try {
    current = await runtime.provider.getShipment(live.providerOrderId!);
  } catch (error) {
    console.warn("[shipping] cancel check read failed; cancel stays requested", { shipmentId: live.id, ...(error instanceof ShipmentProviderError ? error.logFields() : errorLogFields(error)) });
    throw new ActionError(SHIPMENT_MESSAGES.cancelUnknown);
  }
  if (current.knownStatus === "cancelled") {
    await applyProviderShipment(db, live.id, current, { expectBooking: false, actorStaffUserId, action: "refresh_shipment" });
    return settleCancelled(db, live.id, actorStaffUserId);
  }
  const settled = await applyProviderShipment(db, live.id, current, { expectBooking: false, actorStaffUserId, action: "refresh_shipment" });
  const status = settled.row.status;
  if (why === "unknown" && status === "pickup_requested") throw new ActionError(SHIPMENT_MESSAGES.cancelUnknown);
  // Not cancelled: whatever the provider says now stands; the request is withdrawn.
  await db
    .update(shipments)
    .set({ cancelRequestedAt: null, updatedAt: new Date() })
    .where(and(eq(shipments.id, live.id), notInArray(shipments.status, ENDED)));
  throw new ActionError(status === "picked_up" || status === "in_transit" || status === "delivered" ? SHIPMENT_MESSAGES.pastPickup : SHIPMENT_MESSAGES.notCancellable);
}

/** The order's live shipment (any status but cancelled and failed), if any. Read only. */
export async function findLiveShipment(db: Database, orderId: string): Promise<ShipmentRow | null> {
  return liveShipment(db, orderId);
}
