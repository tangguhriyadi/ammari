// The courier and resi staff enter when an order ships (packing "Tandai dikirim", the order page's
// "Ubah resi"). Pure and client-safe: the admin dialog runs the same check before submitting, and
// the server runs it again in transitionOrderStatus / updateShipmentDetails.
//
// A web checkout order (payment_status set) needs both (owner, 2026-10-21 sandbox run: an order
// shipped without a resi sent the buyer a "sudah dikirim" email with no way to track it). Manual and
// marketplace orders keep both optional, as before.

export const COURIER_MAX_LENGTH = 60;
export const TRACKING_NUMBER_MIN_LENGTH = 6;
export const TRACKING_NUMBER_MAX_LENGTH = 40;
/** Manual and marketplace orders: free text as before, only bounded. */
export const FREE_TEXT_TRACKING_MAX_LENGTH = 100;

export const SHIPMENT_DETAIL_MESSAGES = {
  courierRequired: "Isi kurir.",
  courierTooLong: `Kurir maksimal ${COURIER_MAX_LENGTH} karakter.`,
  trackingRequired: "Isi nomor resi.",
  trackingInvalid: `Nomor resi hanya huruf, angka dan tanda hubung, ${TRACKING_NUMBER_MIN_LENGTH} sampai ${TRACKING_NUMBER_MAX_LENGTH} karakter.`,
  trackingTooLong: `Nomor resi maksimal ${FREE_TEXT_TRACKING_MAX_LENGTH} karakter.`,
} as const;

export interface ShipmentDetails {
  courier: string | null;
  trackingNumber: string | null;
}

export type ShipmentDetailsResult =
  | { ok: true; value: ShipmentDetails }
  | { ok: false; errors: { field: "courier" | "trackingNumber"; message: string }[] };

/** One clean line: control characters and runs of whitespace collapse to one space. */
function oneLine(value: string | null | undefined): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A checkout order's resi goes into the buyer's email and "Lacak pengiriman": letters, digits and
 * hyphens only (inner spaces from a copy-paste are dropped), upper case as couriers print it. */
const CHECKOUT_TRACKING_PATTERN = new RegExp(`^[A-Z0-9-]{${TRACKING_NUMBER_MIN_LENGTH},${TRACKING_NUMBER_MAX_LENGTH}}$`);

/** `checkoutOrder`: both fields required and the resi strictly shaped. Otherwise both optional
 * (empty means none) and only capped in length. Every problem at once. */
export function parseShipmentDetails(input: { courier?: string | null; trackingNumber?: string | null }, options: { checkoutOrder: boolean }): ShipmentDetailsResult {
  const errors: { field: "courier" | "trackingNumber"; message: string }[] = [];
  const courier = oneLine(input.courier);
  if (courier.length === 0 && options.checkoutOrder) errors.push({ field: "courier", message: SHIPMENT_DETAIL_MESSAGES.courierRequired });
  else if (courier.length > COURIER_MAX_LENGTH) errors.push({ field: "courier", message: SHIPMENT_DETAIL_MESSAGES.courierTooLong });

  let tracking = oneLine(input.trackingNumber);
  if (options.checkoutOrder) {
    tracking = tracking.replace(/\s+/g, "").toUpperCase();
    if (tracking.length === 0) errors.push({ field: "trackingNumber", message: SHIPMENT_DETAIL_MESSAGES.trackingRequired });
    else if (!CHECKOUT_TRACKING_PATTERN.test(tracking)) errors.push({ field: "trackingNumber", message: SHIPMENT_DETAIL_MESSAGES.trackingInvalid });
  } else if (tracking.length > FREE_TEXT_TRACKING_MAX_LENGTH) {
    errors.push({ field: "trackingNumber", message: SHIPMENT_DETAIL_MESSAGES.trackingTooLong });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { courier: courier || null, trackingNumber: tracking || null } };
}
