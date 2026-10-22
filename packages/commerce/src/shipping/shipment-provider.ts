// The courier booking seam (docs/plans/cart-checkout.md §15 Phase K): Biteship's Order API in
// production, FakeShipmentProvider in tests and e2e. Unlike the rate seam (./provider.ts), a
// booking carries the recipient's name, phone and address: they go to Biteship and the courier only
// once the order is paid and staff book it (privacy policy §11.1 item 3). The buyer's email is never
// sent.
import type { BiteshipOrderStatus, ShipmentTrackingStatus } from "./shipment-rules";

/** `unavailable`: network, timeout, 5xx, a key or rate-limit problem (401, 403, 408, 425, 429), a
 * 404 from a write, or our own budget record failing; `refused`: Biteship answered a 4xx with its
 * own error envelope (validation, balance, courier), so nothing was done; `duplicate_reference`:
 * the `reference_id` was already used (40002060), the booking exists, `existingOrderId` names it
 * when Biteship sent it; `not_found`: Biteship has no such order; `not_cancellable`: Biteship
 * refuses the cancel because of the order's status (40002053: past pickup, or already cancelled);
 * `bad_response`: the body did not have the documented shape; `budget_exhausted`: our own daily cap
 * refused the call before it was sent. */
export type ShipmentProviderErrorReason =
  | "unavailable"
  | "refused"
  | "duplicate_reference"
  | "not_found"
  | "not_cancellable"
  | "bad_response"
  | "budget_exhausted";

export interface ShipmentProviderErrorDetails {
  status?: number;
  providerCode?: number;
  /** A write (booking or cancel) may have taken effect although we did not get a usable answer
   * (timeout, network error, 5xx, an unreadable answer, a 4xx without Biteship's error envelope).
   * Never treat such a booking as "not booked": re-send the same `reference_id`, or read the order,
   * before deciding. A duplicate reference also sets it (the booking exists). */
  outcomeUnknown?: boolean;
  /** `duplicate_reference` only: the existing Biteship order id from the error's `details`. */
  existingOrderId?: string | null;
  cause?: unknown;
}

export class ShipmentProviderError extends Error {
  readonly reason: ShipmentProviderErrorReason;
  readonly status: number | undefined;
  readonly providerCode: number | undefined;
  readonly outcomeUnknown: boolean;
  readonly existingOrderId: string | null;

  constructor(reason: ShipmentProviderErrorReason, message: string, details: ShipmentProviderErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ShipmentProviderError";
    this.reason = reason;
    this.status = details.status;
    this.providerCode = details.providerCode;
    this.outcomeUnknown = details.outcomeUnknown ?? false;
    this.existingOrderId = details.existingOrderId ?? null;
  }

  /** Safe to log: reason, status, provider code, our own message and the cause's name and code
   * (never a URL, header, body, name, phone or address). */
  logFields(): Record<string, unknown> {
    const cause = this.cause;
    const causeSummary =
      cause instanceof Error
        ? { name: cause.name, code: (cause as { code?: unknown }).code ?? (cause.cause as { code?: unknown } | undefined)?.code }
        : undefined;
    return {
      reason: this.reason,
      status: this.status,
      providerCode: this.providerCode,
      outcomeUnknown: this.outcomeUnknown,
      message: this.message,
      cause: causeSummary,
    };
  }
}

/** Which daily budget a booking-side request draws on (decision 48): `orders` for every read
 * (`GET /v1/orders/:id`, from the webhook and the poller), `order_writes` for bookings and cancels. */
export type ShipmentCallKind = "orders" | "order_writes";

export interface ShipmentAddress {
  /** Already validated and cleaned single-line text. */
  name: string;
  /** E.164 `+628...` (converted to Biteship's `08...` by the client). */
  phone: string;
  address: string;
  /** The Biteship area id (`BITESHIP_ORIGIN_AREA_ID`, or the order's `shipping_destination_id`). */
  /** The kode pos is part of the area id, so no postal code is sent beside it. */
  areaId: string;
  /** The courier note (`origin_note` / `destination_note`). */
  note?: string | null;
}

export interface CreateShipmentInput {
  /** `shipmentReferenceId(prefix, orderNo, attempt)`. */
  referenceId: string;
  /** Ammari (BITESHIP_SHIPPER_*): sent as shipper and origin contact. */
  origin: ShipmentAddress;
  destination: ShipmentAddress;
  /** The locked quote's courier and service (`orders.shipping_courier_code` / `_service_code`). */
  courierCode: string;
  serviceCode: string;
  /** One item for the parcel, as quoted (plan §4.5.3), so the booked price matches the quote. */
  item: { name: string; value: number; weightGrams: number; quantity: number };
  orderNote?: string | null;
}

export interface ShipmentHistoryEntry {
  /** Canonical snake_case when documented, otherwise the raw text (trimmed, capped). */
  providerStatus: string;
  status: ShipmentTrackingStatus | null;
  /** The courier's own text, cleaned to one line and capped. */
  note: string;
  occurredAt: Date;
}

export interface ShipmentDriver {
  name: string | null;
  phone: string | null;
  plateNumber: string | null;
}

/** What Biteship says about one order, after parsing. Every field Biteship documents as nullable is
 * nullable here. */
export interface ProviderShipment {
  providerOrderId: string;
  referenceId: string | null;
  /** The raw status as sent (trimmed), and its documented form when known. */
  providerStatus: string | null;
  knownStatus: BiteshipOrderStatus | null;
  status: ShipmentTrackingStatus | null;
  waybillId: string | null;
  trackingId: string | null;
  routingCode: string | null;
  courierCode: string | null;
  serviceCode: string | null;
  /** What Ammari pays, whole rupiah (`price`), when Biteship sent a whole non-negative number. */
  price: number | null;
  /** The courier's public tracking page, https only. */
  trackingLink: string | null;
  driver: ShipmentDriver | null;
  /** Oldest first. */
  history: ShipmentHistoryEntry[];
}

export type ShipmentCancelReasonCode = "change_courier" | "pickup_delay" | "change_address" | "others";

export interface CancelShipmentInput {
  reasonCode: ShipmentCancelReasonCode;
  /** Free text, sent with `others` (Biteship's examples send it with that code). */
  reason?: string | null;
}

export interface CancelledShipment {
  providerOrderId: string;
  providerStatus: string | null;
}

export interface ShipmentProvider {
  readonly name: "biteship" | "fake";
  /** `POST /v1/orders` with `delivery_type: now` and `origin_collection_method: pickup` (decision 46).
   * Never retried by the client: on `outcomeUnknown` the caller re-sends the same reference. A
   * returned order whose `reference_id` differs from the one sent is a bad response. */
  createShipment(input: CreateShipmentInput): Promise<ProviderShipment>;
  /** `GET /v1/orders/:id`: status, waybill, price and the courier history in one call. An id that
   * is not shaped like Biteship's throws a RangeError (our own data is wrong), never `not_found`. */
  getShipment(providerOrderId: string): Promise<ProviderShipment>;
  /** `POST /v1/orders/:id/cancel`, only before pickup. After `outcomeUnknown` or `not_cancellable`,
   * read the order: a lost answer to a cancel that worked is re-answered `not_cancellable`. */
  cancelShipment(providerOrderId: string, input: CancelShipmentInput): Promise<CancelledShipment>;
}
