import type { ShipmentEventSource, ShipmentStatus } from "@ammari/db/schema";
import type { BadgeVariant } from "@ammari/ui";
import { pickupCutoffFor, shipmentPickupState, type ShipmentPickupState } from "@ammari/commerce/shipment-rules";

// Indonesian labels for courier bookings on /packing and the order page (docs/plans/cart-checkout.md
// §15 Phase K, K2). Staff-facing, so the provider may be named. Client-safe.

export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  booking: "Pemesanan belum pasti",
  failed: "Gagal dipesan",
  pickup_requested: "Kurir dipesan",
  picked_up: "Sudah dijemput",
  in_transit: "Dalam perjalanan",
  delivered: "Sampai",
  cancelled: "Dibatalkan",
  returning: "Sedang dikembalikan",
  returned: "Kembali ke pengirim",
  problem: "Bermasalah",
};

export const SHIPMENT_STATUS_BADGE_VARIANT: Record<ShipmentStatus, BadgeVariant> = {
  booking: "warning",
  failed: "neutral",
  pickup_requested: "success",
  picked_up: "success",
  in_transit: "success",
  delivered: "success",
  cancelled: "neutral",
  returning: "danger",
  returned: "danger",
  problem: "danger",
};

export const PICKUP_STATE_LABELS: Record<ShipmentPickupState, string> = {
  waiting: "Menunggu kurir",
  courier_on_the_way: "Kurir menuju lokasi",
  picked_up: "Sudah dijemput",
};

export function pickupStateLabel(providerStatus: string | null): string | null {
  const state = shipmentPickupState(providerStatus);
  return state ? PICKUP_STATE_LABELS[state] : null;
}

/** "Pesan sebelum 14.00 WIB supaya dijemput hari ini." for the allowlisted couriers (a hint only). */
export function pickupCutoffHint(courierCode: string): string | null {
  const cutoff = pickupCutoffFor(courierCode);
  return cutoff ? `Pesan sebelum ${cutoff} WIB supaya dijemput hari ini; setelahnya dijemput hari kerja berikutnya.` : null;
}

/** The live attempt (not cancelled or failed), if any. */
export function isLiveShipmentStatus(status: ShipmentStatus): boolean {
  return status !== "cancelled" && status !== "failed";
}

/** Where a courier history entry came from (K3 `shipment_events.source`). */
export const SHIPMENT_EVENT_SOURCE_LABELS: Record<ShipmentEventSource, string> = {
  webhook: "Webhook",
  poll: "Cek berkala",
  staff: "Staf (pesan kurir, cek ulang)",
};

/** A history entry's state in words; an undocumented courier status is named as such. */
export function shipmentEventLabel(normalizedStatus: ShipmentStatus | null): string {
  return normalizedStatus ? SHIPMENT_STATUS_LABELS[normalizedStatus] : "Status tidak dikenal";
}

/** Booked and still on its way (not ended, not final): the poll reads it. */
export function isOpenShipmentStatus(status: ShipmentStatus): boolean {
  return status === "pickup_requested" || status === "picked_up" || status === "in_transit" || status === "returning" || status === "problem";
}
