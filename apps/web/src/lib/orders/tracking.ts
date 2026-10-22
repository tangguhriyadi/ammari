import { formatJakartaDateTime } from "@/lib/format";

// The buyer's courier timeline in "Lacak pengiriman" on /orders/[orderNo] (docs/plans/
// cart-checkout.md §9.1, §15 Phase K, K4; docs/design/storefront.md §7). Pure: the server reads the
// order's courier booking and its `shipment_events`, this decides what the buyer sees. Courier words
// only, in Indonesian: never the shipping provider's name, never a cost, a driver or an internal
// error. The courier's own note is shown as sent (React escapes it), unless it names the provider.

/** Our words for each documented courier status (the stored `provider_status` is the documented
 * snake_case when known). */
const STATUS_LABELS: Record<string, string> = {
  confirmed: "Kurir dipesan",
  scheduled: "Penjemputan dijadwalkan",
  allocated: "Kurir sudah ditugaskan",
  picking_up: "Kurir menuju lokasi penjemputan",
  picked: "Paket dijemput kurir",
  in_transit: "Paket dalam perjalanan",
  dropping_off: "Paket sedang diantar ke alamatmu",
  delivered: "Paket sudah sampai",
  on_hold: "Pengiriman tertahan sementara",
  rejected: "Ada kendala pengiriman",
  disposed: "Ada kendala pengiriman",
  courier_not_found: "Ada kendala pengiriman",
  return_in_transit: "Paket dalam perjalanan kembali ke pengirim",
  returned: "Paket kembali ke pengirim",
  cancelled: "Pengiriman dibatalkan",
};

/** Fallbacks by our own state, for a status spelled in a way the table above does not know. */
const STATE_LABELS: Record<string, string> = {
  pickup_requested: "Kurir dipesan",
  picked_up: "Paket dijemput kurir",
  in_transit: "Paket dalam perjalanan",
  delivered: "Paket sudah sampai",
  returning: "Paket dalam perjalanan kembali ke pengirim",
  returned: "Paket kembali ke pengirim",
  problem: "Ada kendala pengiriman",
  cancelled: "Pengiriman dibatalkan",
};

const UNKNOWN_LABEL = "Kabar dari kurir";

/** Lifecycle order, for entries a courier stamps with the same time (the later step goes on top). */
const STEP_RANK: Record<string, number> = Object.fromEntries(
  ["confirmed", "scheduled", "allocated", "picking_up", "picked", "in_transit", "dropping_off", "on_hold", "rejected", "courier_not_found", "disposed", "return_in_transit", "returned", "cancelled", "delivered"].map((status, index) => [status, index]),
);

function stepRank(event: TrackingEventInput): number {
  return STEP_RANK[event.providerStatus] ?? -1;
}

/** Shipment states the courier is still working on (the gentle delay notes only apply then). */
const OPEN_STATES: ReadonlySet<string> = new Set(["pickup_requested", "picked_up", "in_transit", "returning", "problem"]);

/** Reads that will not succeed by retrying (packages/commerce/src/shipping/tracking.ts); each one
 * flags `delivery_problem` for staff. */
const PERMANENT_READ_ERRORS: ReadonlySet<string> = new Set(["read:not_found", "read:bad_response", "read:refused", "read:mismatch", "read:invalid_id"]);

/** The courier's note is never shown when it names the provider (the storefront never does). */
const PROVIDER_NAME = /biteship/i;
/** Nor when it carries a phone number (a driver's or the recipient's): the buyer never sees one. */
const PHONE_LIKE = /\+?\d[\d\s().-]{7,}\d/;
const NOTE_MAX_LENGTH = 200;
/** The newest entries only; an ordinary parcel has fewer than ten. */
export const BUYER_TRACKING_MAX_EVENTS = 30;

export const TRACKING_DELAY_NOTES = {
  read: "Kabar pengiriman terbaru belum bisa kami tampilkan. Kami cek lagi otomatis, coba lihat lagi nanti.",
  stale: "Belum ada kabar baru dari kurir. Tim kami sedang mengeceknya.",
} as const;

export type TrackingDelay = keyof typeof TRACKING_DELAY_NOTES;

export interface TrackingShipmentInput {
  awb: string | null;
  status: string;
  /** `read:<reason>` when the last automatic read failed (K3); booking errors otherwise. */
  lastError: string | null;
  staleFlaggedAt: Date | null;
  lastEventAt: Date | null;
  bookedAt: Date | null;
  createdAt: Date;
}

export interface TrackingEventInput {
  occurredAt: Date;
  providerStatus: string;
  normalizedStatus: string | null;
  description: string;
  location: string | null;
}

export interface BuyerTrackingInput {
  orderStatus: string;
  /** The resi on the order (what the buyer got by email). */
  trackingNumber: string | null;
  /** The order's current courier booking (not cancelled or failed), if any. */
  shipment: TrackingShipmentInput | null;
  events: readonly TrackingEventInput[];
}

export interface BuyerTrackingEvent {
  label: string;
  /** The courier's own note (and place), one line; null when there is none to show. */
  note: string | null;
  /** "22 Oktober 2026, 14.30 WIB". */
  at: string;
  /** ISO time for `<time dateTime>`. */
  dateTime: string;
}

export interface BuyerTracking {
  /** Latest first. */
  events: BuyerTrackingEvent[];
  delay: TrackingDelay | null;
}

export function buyerTrackingLabel(providerStatus: string, normalizedStatus: string | null): string {
  return STATUS_LABELS[providerStatus] ?? (normalizedStatus ? STATE_LABELS[normalizedStatus] : undefined) ?? UNKNOWN_LABEL;
}

function compactResi(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

function buyerNote(event: TrackingEventInput): string | null {
  const parts = [oneLine(event.description), oneLine(event.location ?? "")].filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const note = parts.join(" · ");
  if (PROVIDER_NAME.test(note) || PHONE_LIKE.test(note)) return null;
  return note.length > NOTE_MAX_LENGTH ? `${note.slice(0, NOTE_MAX_LENGTH - 1).trimEnd()}…` : note;
}

const EMPTY: BuyerTracking = { events: [], delay: null };

/** What "Lacak pengiriman" shows below the courier and resi. Nothing at all when the order's resi
 * is not the booking's waybill (staff shipped it another way, or are fixing a mismatch: the timeline
 * would belong to a different parcel). */
export function buyerTracking(input: BuyerTrackingInput): BuyerTracking {
  const { shipment } = input;
  if (!shipment) return EMPTY;
  if (input.trackingNumber !== null && (shipment.awb === null || compactResi(shipment.awb) !== compactResi(input.trackingNumber))) return EMPTY;

  const events = [...input.events]
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || stepRank(b) - stepRank(a))
    .slice(0, BUYER_TRACKING_MAX_EVENTS)
    .map((event) => ({
      label: buyerTrackingLabel(event.providerStatus, event.normalizedStatus),
      note: buyerNote(event),
      at: formatJakartaDateTime(event.occurredAt),
      dateTime: event.occurredAt.toISOString(),
    }));

  let delay: TrackingDelay | null = null;
  if ((input.orderStatus === "to_ship" || input.orderStatus === "shipped") && OPEN_STATES.has(shipment.status)) {
    const quietSince = shipment.lastEventAt ?? shipment.bookedAt ?? shipment.createdAt;
    // A read that keeps failing for good is flagged for staff (K3): "we are checking", never the
    // promise of an automatic re-check.
    if (shipment.lastError !== null && PERMANENT_READ_ERRORS.has(shipment.lastError)) delay = "stale";
    else if (shipment.lastError?.startsWith("read:")) delay = "read";
    else if (shipment.staleFlaggedAt !== null && shipment.staleFlaggedAt.getTime() >= quietSince.getTime()) delay = "stale";
  }
  return { events, delay };
}
