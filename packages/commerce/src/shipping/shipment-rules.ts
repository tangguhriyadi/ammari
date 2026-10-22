// Courier booking and tracking rules (docs/plans/cart-checkout.md §15 Phase K, decisions 46 to 51).
// Pure: no server-only, no DB, so admin and storefront UI can read the statuses and the cut-off
// hints too. Biteship's documented statuses (https://biteship.com/id/docs/api/orders/overview,
// read 2026-10-22): orders use snake_case (`picking_up`), the tracking statuses page spells the same
// states in camelCase (`pickingUp`, https://biteship.com/id/docs/api/trackings/status); both are
// accepted and stored in the snake_case form.

/** Every status Biteship documents for an order, in snake_case. */
export const BITESHIP_ORDER_STATUSES = [
  "confirmed",
  "scheduled",
  "allocated",
  "picking_up",
  "picked",
  "in_transit",
  "dropping_off",
  "delivered",
  "on_hold",
  "return_in_transit",
  "returned",
  "rejected",
  "disposed",
  "courier_not_found",
  "cancelled",
] as const;

export type BiteshipOrderStatus = (typeof BITESHIP_ORDER_STATUSES)[number];

/** Our normalized shipment state (plan §3 `shipments.status`, Phase K). `cancelled` means the
 * shipment ended before pickup (by us, by Biteship, or because no courier was found), so the order
 * can be booked again; `problem` needs staff (on hold, rejected, disposed). */
export const SHIPMENT_TRACKING_STATUSES = [
  "pickup_requested",
  "picked_up",
  "in_transit",
  "delivered",
  "cancelled",
  "returning",
  "returned",
  "problem",
] as const;

export type ShipmentTrackingStatus = (typeof SHIPMENT_TRACKING_STATUSES)[number];

const NORMALIZED: Record<BiteshipOrderStatus, ShipmentTrackingStatus> = {
  confirmed: "pickup_requested",
  scheduled: "pickup_requested",
  allocated: "pickup_requested",
  picking_up: "pickup_requested",
  picked: "picked_up",
  in_transit: "in_transit",
  dropping_off: "in_transit",
  delivered: "delivered",
  on_hold: "problem",
  return_in_transit: "returning",
  returned: "returned",
  rejected: "problem",
  disposed: "problem",
  // "Canceled because no courier was available" (tracking statuses page): nothing was picked up,
  // so it ends the shipment like a cancel; K3 still flags it because we did not ask for it.
  courier_not_found: "cancelled",
  cancelled: "cancelled",
};

/** Statuses Biteship still lets us cancel ("Deletable" column of the orders overview). */
export const BITESHIP_CANCELLABLE_STATUSES: ReadonlySet<BiteshipOrderStatus> = new Set(["confirmed", "scheduled", "allocated", "picking_up"]);

/** Statuses after which nothing more is expected (the docs mark none as final; these are the ones
 * with no documented way forward). The poller stops asking about a shipment in one of them. */
export const BITESHIP_FINAL_STATUSES: ReadonlySet<BiteshipOrderStatus> = new Set([
  "delivered",
  "returned",
  "cancelled",
  "rejected",
  "disposed",
  "courier_not_found",
]);

const KNOWN: ReadonlySet<string> = new Set(BITESHIP_ORDER_STATUSES);

/** The documented snake_case spelling of a status Biteship sent (`pickingUp`, `PICKING_UP`, `picking
 * up` and `picking_up` all give `picking_up`; `canceled` gives `cancelled`), or null for anything it does not document. An
 * unknown status must never complete an order (plan §15 Phase K). */
export function canonicalBiteshipStatus(raw: string): BiteshipOrderStatus | null {
  const snake = raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
  // The tracking statuses page writes "Canceled" (US spelling) in its descriptions.
  const spelled = snake === "canceled" ? "cancelled" : snake;
  return KNOWN.has(spelled) ? (spelled as BiteshipOrderStatus) : null;
}

/** Our state for a status Biteship sent, or null when the status is unknown (stored raw, flagged). */
export function normalizeBiteshipStatus(raw: string): ShipmentTrackingStatus | null {
  const known = canonicalBiteshipStatus(raw);
  return known ? NORMALIZED[known] : null;
}

/** `BITESHIP_REFERENCE_PREFIX` (decision 51): dev and local share one Biteship test account and both
 * number orders `ORD-YYYYMM-NNNN`, so each environment's reference ids carry their own prefix, like
 * `MIDTRANS_ORDER_ID_PREFIX` (D7). Empty only in production. */
export const SHIPMENT_REFERENCE_PREFIX_PATTERN = /^[A-Z0-9-]{0,16}$/;

/** Prefixes that name a non-production environment (dev, local, e2e, the contract test): refused in
 * production, so a copied env file cannot label live bookings as test ones. */
export const NON_PRODUCTION_REFERENCE_PREFIXES: readonly string[] = ["DEV-", "LOCAL-", "E2E-", "CT-", "TEST-"];

export const SHIPMENT_MAX_ATTEMPTS = 99;

/** Biteship `reference_id` for one booking attempt: `<prefix><order_no>-K<attempt>`. Unique per
 * attempt, so a re-sent booking of the same attempt is refused by Biteship as a duplicate (code
 * 40002060, which names the existing order) and never books twice. */
export function shipmentReferenceId(prefix: string, orderNo: string, attempt: number): string {
  if (!SHIPMENT_REFERENCE_PREFIX_PATTERN.test(prefix)) throw new RangeError("shipment reference prefix must be A-Z, 0-9 or '-', at most 16 characters");
  if (!/^[A-Z0-9-]{1,40}$/.test(orderNo)) throw new RangeError("order number must be A-Z, 0-9 or '-'");
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > SHIPMENT_MAX_ATTEMPTS) throw new RangeError(`shipment attempt must be 1 to ${SHIPMENT_MAX_ATTEMPTS}`);
  return `${prefix}${orderNo}-K${attempt}`;
}

/** An E.164 Indonesian mobile number (`+62812...`, the form `normalizeIndonesianPhone` stores) in
 * the local form Biteship's examples use (`0812...`). Throws on anything else: callers pass numbers
 * that were already validated. */
export function toBiteshipPhone(e164: string): string {
  if (!/^\+628[0-9]{7,12}$/.test(e164)) throw new RangeError("expected a +62 mobile number");
  return `0${e164.slice(3)}`;
}

/** Same-day pickup cut-offs in WIB for the allowlisted regular services (Biteship help center
 * "Batas waktu request pickup", https://help.biteship.com/hc/id/articles/48424915220377, read
 * 2026-10-22; written for the dashboard's pickup button, assumed to hold for API bookings). A
 * booking after the cut-off is picked up on the next operating day. Shown to staff as a hint only. */
export const SHIPPING_PICKUP_CUTOFFS: Readonly<Record<string, string>> = {
  jne: "14.00",
  jnt: "15.59",
  sicepat: "17.00",
  anteraja: "14.00",
  idexpress: "15.00",
  pos: "16.00",
};

export function pickupCutoffFor(courierCode: string): string | null {
  return SHIPPING_PICKUP_CUTOFFS[courierCode.trim().toLowerCase()] ?? null;
}

/** Decision 47: the actual courier price may exceed the locked quote by this much (whole rupiah)
 * before the order is flagged `shipping_cost_over_quote`. Ammari pays the difference either way. */
export const SHIPPING_COST_OVER_QUOTE_THRESHOLD = 5_000;

export function isShippingCostOverQuote(actualAmount: number, quotedAmount: number): boolean {
  return actualAmount - quotedAmount > SHIPPING_COST_OVER_QUOTE_THRESHOLD;
}

/** What staff see about the pickup on a booked shipment (K2): "Menunggu kurir" until a courier is
 * on the way, "Kurir menuju lokasi" while `picking_up`, "Sudah dijemput" from `picked` on. Null for
 * a shipment that is not booked, ended, or in a status we do not know. */
export type ShipmentPickupState = "waiting" | "courier_on_the_way" | "picked_up";

const PICKED_UP_OR_LATER: ReadonlySet<BiteshipOrderStatus> = new Set(["picked", "in_transit", "dropping_off", "delivered", "return_in_transit", "returned"]);

export function shipmentPickupState(providerStatus: string | null): ShipmentPickupState | null {
  const known = providerStatus ? canonicalBiteshipStatus(providerStatus) : null;
  if (!known) return null;
  if (known === "picking_up") return "courier_on_the_way";
  if (known === "confirmed" || known === "scheduled" || known === "allocated") return "waiting";
  return PICKED_UP_OR_LATER.has(known) ? "picked_up" : null;
}
