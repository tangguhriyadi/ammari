import "server-only";
import { z } from "zod";
import { joinUrl, delay, isTimeoutError } from "./biteship-http";
import { ShippingRateError } from "./provider";
import {
  ShipmentProviderError,
  type CancelShipmentInput,
  type CancelledShipment,
  type CreateShipmentInput,
  type ProviderShipment,
  type ShipmentCallKind,
  type ShipmentHistoryEntry,
  type ShipmentProvider,
} from "./shipment-provider";
import { canonicalBiteshipStatus, normalizeBiteshipStatus, toBiteshipPhone } from "./shipment-rules";

// Biteship Order API client (docs/plans/cart-checkout.md §15 Phase K, K1). Documented at
// https://biteship.com/id/docs (read 2026-10-22; findings and links in the plan's Phase K section):
// - `POST /v1/orders` (https://biteship.com/id/docs/api/orders/create): shipper/origin/destination
//   contacts and address, `*_area_id` from Maps, `courier_company` + `courier_type` (the rates
//   `courier_code` + `courier_service_code`), `delivery_type` `now` ("generate waybill instantly
//   and pickup right away"), `origin_collection_method` `pickup` (the default), `items[]`, and a
//   `reference_id` that must be unique: a repeat answers code 40002060 with the existing order in
//   `details` (https://biteship.com/id/docs/api/orders/error). Answers `{ success, id, price,
//   status: "confirmed", courier: { tracking_id, waybill_id, company, type, link } }`.
// - `GET /v1/orders/:id` (https://biteship.com/id/docs/api/orders/retrieve): every field nullable;
//   adds `courier.routing_code`, `courier.history[] { status, note, updated_at }` and the driver.
//   One call gives status, waybill, price and history, so `GET /v1/trackings/:id` is not used.
// - `POST /v1/orders/:id/cancel` (https://biteship.com/id/docs/api/orders/delete) with
//   `cancellation_reason_code`; only while `confirmed` / `scheduled` / `allocated` / `picking_up`,
//   otherwise 40002053. `DELETE /v1/orders/:id` is deprecated.
// - errors are `{ success: false, error, code }`; the docs give no HTTP status per code.
// Same host, raw-key `authorization` header and `redirect: "error"` as the rate client. Bookings
// and cancels are never retried here (a lost answer is re-sent by the caller with the same
// reference); reads are retried once on a network error or 5xx.

export const BITESHIP_CREATE_TIMEOUT_MS = 15_000;
export const BITESHIP_CANCEL_TIMEOUT_MS = 15_000;
export const BITESHIP_READ_TIMEOUT_MS = 10_000;
export const BITESHIP_READ_RETRY_DELAY_MS = 300;

/** "Reference id has already been used before" (orders error table). */
export const BITESHIP_DUPLICATE_REFERENCE_CODE = 40002060;
/** "Can't cancel order, order already has a status that blocks cancellation". */
export const BITESHIP_NOT_CANCELLABLE_CODE = 40002053;
/** Cancel failures on Biteship's or the courier's side ("failed to cancel development order",
 * "failed to cancel courier", "cancellation failed"): worth trying again later, not a refusal. */
const BITESHIP_CANCEL_RETRYABLE_CODES = new Set([40002054, 40002055, 40002056]);

/** The ids we put in a URL path: Biteship's are 24-character hex in every example. */
const PROVIDER_ORDER_ID = /^[A-Za-z0-9_-]{1,100}$/;

const NOTE_MAX = 300;
const TOKEN_MAX = 100;

export interface BiteshipOrdersClientOptions {
  apiKey: string;
  /** `BITESHIP_BASE_URL`, validated by the config. Never user input. */
  baseUrl: string;
  /** Called before every HTTP attempt; throws (a `budget_exhausted` ShippingRateError) to refuse. */
  beforeRequest?: (kind: ShipmentCallKind) => Promise<void>;
  fetch?: typeof fetch;
  createTimeoutMs?: number;
  cancelTimeoutMs?: number;
  readTimeoutMs?: number;
  readRetryDelayMs?: number;
}

/** Biteship's error envelope, read leniently: a `code` sent as a numeric string still counts, and
 * one odd field never hides the others (a duplicate reference must never be missed). `parsed` is
 * true only for an object with `success: false` and a numeric code: the only answer we trust as
 * Biteship's own refusal. */
function readErrorEnvelope(json: unknown): { parsed: boolean; code: number | undefined; existingOrderId: string | null } {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { parsed: false, code: undefined, existingOrderId: null };
  const record = json as Record<string, unknown>;
  const rawCode = record.code;
  const code =
    typeof rawCode === "number" && Number.isSafeInteger(rawCode)
      ? rawCode
      : typeof rawCode === "string" && /^[0-9]{1,12}$/.test(rawCode.trim())
        ? Number(rawCode.trim())
        : undefined;
  const details = record.details;
  const rawExisting = typeof details === "object" && details !== null ? (details as Record<string, unknown>).order_id : undefined;
  const existing = typeof rawExisting === "string" ? rawExisting.trim() : "";
  return {
    parsed: record.success === false && code !== undefined,
    code,
    existingOrderId: PROVIDER_ORDER_ID.test(existing) ? existing : null,
  };
}

/** Control and format characters become spaces, whitespace collapses, capped: courier notes and
 * names arrive as free text and are shown in admin, the storefront and on our label. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return null;
  return text.length > max ? text.slice(0, max).trimEnd() : text;
}

/** A waybill, tracking id, reference or courier code: one token without spaces, at most 100
 * characters, never truncated. A value that was sent but fails is logged by field name only (a
 * null waybill must not pass silently for "not issued yet"). */
function cleanToken(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const text = typeof value === "string" ? value.replace(/\p{Cf}/gu, "").trim() : "";
  if (text !== "" && text.length <= TOKEN_MAX && /^[\x21-\x7e]+$/.test(text)) return text;
  console.warn(`[shipping] Biteship order: ${field} was sent but is not a usable token`, { type: typeof value, length: typeof value === "string" ? value.length : undefined });
  return null;
}

function httpsLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function wholeRupiah(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const historyRow = z.object({
  status: z.string().trim().min(1).max(100),
  note: z.unknown().optional(),
  updated_at: z.string().trim().min(1),
});

/** A history time. One without an offset is read as WIB (Biteship's own examples carry `+07:00`),
 * never as the server's local time. */
function parseProviderTime(value: string): Date | null {
  const text = value.trim();
  const hasOffset = /(?:[zZ]|[+-][0-9]{2}:?[0-9]{2})$/.test(text);
  const date = new Date(hasOffset || !/[0-9]{2}:[0-9]{2}/.test(text) ? text : `${text.replace(" ", "T")}+07:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Status strings are not personal data: an unknown one is logged as sent (capped), once per
 * answer, because K3 will store it raw and flag the order. */
function warnUnknownStatuses(statuses: string[]): void {
  if (statuses.length > 0) console.warn("[shipping] Biteship order: undocumented status", { statuses: [...new Set(statuses)].slice(0, 5).map((status) => status.slice(0, 50)) });
}

function parseHistory(raw: unknown, unknownStatuses: string[]): ShipmentHistoryEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    console.warn("[shipping] Biteship order: history is not a list", { type: typeof raw });
    return [];
  }
  const entries: ShipmentHistoryEntry[] = [];
  let skipped = 0;
  for (const item of raw) {
    const row = historyRow.safeParse(item);
    const occurredAt = row.success ? parseProviderTime(row.data.updated_at) : null;
    if (!row.success || !occurredAt) {
      skipped += 1;
      continue;
    }
    const known = canonicalBiteshipStatus(row.data.status);
    if (!known) unknownStatuses.push(row.data.status);
    entries.push({
      providerStatus: known ?? cleanText(row.data.status, 100) ?? "unknown",
      status: normalizeBiteshipStatus(row.data.status),
      note: cleanText(row.data.note, NOTE_MAX) ?? "",
      occurredAt,
    });
  }
  // Counts only: notes can carry the recipient's name or address.
  if (skipped > 0) console.warn(`[shipping] Biteship order: skipped ${skipped} malformed history rows`);
  return entries.map((entry, index) => ({ entry, index })).sort((a, b) => a.entry.occurredAt.getTime() - b.entry.occurredAt.getTime() || a.index - b.index).map(({ entry }) => entry);
}

const orderBody = z.object({
  success: z.literal(true),
  id: z.string().trim().regex(PROVIDER_ORDER_ID),
  reference_id: z.unknown().optional(),
  status: z.unknown().optional(),
  price: z.unknown().optional(),
  courier: z.unknown().optional(),
});

/** The documented order shape, leniently: only `success` and `id` are required; any other field
 * that is missing or odd becomes null, so one surprising field never hides the status. */
export function parseBiteshipOrder(json: unknown): ProviderShipment | null {
  const body = orderBody.safeParse(json);
  if (!body.success) return null;
  const rawCourier = body.data.courier;
  const courierIsObject = typeof rawCourier === "object" && rawCourier !== null && !Array.isArray(rawCourier);
  if (!courierIsObject && rawCourier !== undefined && rawCourier !== null) console.warn("[shipping] Biteship order: courier is not an object", { type: typeof rawCourier });
  const courier: Record<string, unknown> = courierIsObject ? (rawCourier as Record<string, unknown>) : {};
  const unknownStatuses: string[] = [];
  const rawStatus = cleanText(body.data.status, 100);
  if (rawStatus === null) console.warn("[shipping] Biteship order: no status", { type: typeof body.data.status });
  else if (!canonicalBiteshipStatus(rawStatus)) unknownStatuses.push(rawStatus);
  const price = wholeRupiah(body.data.price);
  // A missing price must be visible: the over-quote check (decision 47) cannot run without it.
  if (price === null) console.warn("[shipping] Biteship order: no whole rupiah price", { type: body.data.price === null ? "null" : typeof body.data.price });
  const history = parseHistory(courier.history, unknownStatuses);
  warnUnknownStatuses(unknownStatuses);
  const driverName = cleanText(courier.driver_name, 100);
  const driverPhone = cleanText(courier.driver_phone, 30);
  const driverPlate = cleanText(courier.driver_plate_number, 20);
  return {
    providerOrderId: body.data.id,
    referenceId: cleanToken(body.data.reference_id, "reference_id"),
    providerStatus: rawStatus,
    knownStatus: rawStatus ? canonicalBiteshipStatus(rawStatus) : null,
    status: rawStatus ? normalizeBiteshipStatus(rawStatus) : null,
    waybillId: cleanToken(courier.waybill_id, "waybill_id"),
    trackingId: cleanToken(courier.tracking_id, "tracking_id"),
    routingCode: cleanText(courier.routing_code, 50),
    courierCode: cleanToken(courier.company, "company"),
    serviceCode: cleanToken(courier.type, "type"),
    price,
    trackingLink: httpsLink(courier.link),
    driver: driverName || driverPhone || driverPlate ? { name: driverName, phone: driverPhone, plateNumber: driverPlate } : null,
    history,
  };
}

function assertWholePositive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${field} must be a positive whole number`);
}

/** Free text for Biteship and the courier: one line, capped. A required field that is empty after
 * cleaning is a programming error upstream (callers pass validated order data). */
function requiredText(value: string, max: number, field: string): string {
  const text = cleanText(value, max);
  if (!text) throw new RangeError(`${field} is empty`);
  return text;
}

/** The documented request body. The buyer's email, insurance and COD are never sent. */
export function biteshipOrderRequestBody(input: CreateShipmentInput): Record<string, unknown> {
  assertWholePositive(input.item.value, "item value");
  assertWholePositive(input.item.weightGrams, "item weight");
  assertWholePositive(input.item.quantity, "item quantity");
  if (!/^[\x21-\x7e]{1,100}$/.test(input.referenceId)) throw new RangeError("reference id must be printable ASCII");
  const originName = requiredText(input.origin.name, 100, "origin name");
  const originPhone = toBiteshipPhone(input.origin.phone);
  const originNote = cleanText(input.origin.note, 200);
  const destinationNote = cleanText(input.destination.note, 200);
  const orderNote = cleanText(input.orderNote, 200);
  return {
    shipper_contact_name: originName,
    shipper_contact_phone: originPhone,
    shipper_organization: originName,
    origin_contact_name: originName,
    origin_contact_phone: originPhone,
    origin_address: requiredText(input.origin.address, 500, "origin address"),
    ...(originNote ? { origin_note: originNote } : {}),
    origin_area_id: requiredText(input.origin.areaId, 100, "origin area"),
    origin_collection_method: "pickup",
    destination_contact_name: requiredText(input.destination.name, 100, "destination name"),
    destination_contact_phone: toBiteshipPhone(input.destination.phone),
    destination_address: requiredText(input.destination.address, 500, "destination address"),
    ...(destinationNote ? { destination_note: destinationNote } : {}),
    destination_area_id: requiredText(input.destination.areaId, 100, "destination area"),
    courier_company: requiredText(input.courierCode, 50, "courier"),
    courier_type: requiredText(input.serviceCode, 100, "service"),
    delivery_type: "now",
    reference_id: input.referenceId,
    ...(orderNote ? { order_note: orderNote } : {}),
    items: [
      {
        name: requiredText(input.item.name, 100, "item name"),
        category: "fashion",
        value: input.item.value,
        quantity: input.item.quantity,
        weight: input.item.weightGrams,
      },
    ],
  };
}

interface SendOptions {
  timeoutMs: number;
  /** Retry once after a network error or 5xx (reads only). */
  retry: boolean;
  /** A write that may have taken effect when the answer is lost. */
  write: boolean;
}

/** Statuses that mean "try again later", not "Biteship refused": auth, timeout, rate limit. */
const TRANSIENT_4XX = new Set([401, 403, 408, 425, 429]);

export function createBiteshipOrdersClient(options: BiteshipOrdersClientOptions): ShipmentProvider {
  const readRetryDelayMs = options.readRetryDelayMs ?? BITESHIP_READ_RETRY_DELAY_MS;

  async function send(kind: ShipmentCallKind, url: URL, init: RequestInit, opts: SendOptions): Promise<{ status: number; json: unknown; isJson: boolean }> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await options.beforeRequest?.(kind);
      } catch (error) {
        if (error instanceof ShippingRateError && error.reason === "budget_exhausted") {
          throw new ShipmentProviderError("budget_exhausted", error.message, { cause: error });
        }
        // Nothing was sent (the budget could not be recorded): unavailable, never a lost write.
        throw new ShipmentProviderError("unavailable", `Biteship ${kind} budget check failed`, { cause: error });
      }
      let response: Response;
      try {
        response = await (options.fetch ?? globalThis.fetch)(url, {
          ...init,
          headers: { ...init.headers, authorization: options.apiKey, accept: "application/json" },
          signal: AbortSignal.timeout(opts.timeoutMs),
          cache: "no-store",
          redirect: "error",
        });
      } catch (error) {
        const timedOut = isTimeoutError(error);
        if (opts.retry && !timedOut && attempt === 1) {
          console.warn(`[shipping] Biteship ${kind} request failed; retrying once`, { cause: error instanceof Error ? error.name : typeof error });
          await delay(readRetryDelayMs);
          continue;
        }
        throw new ShipmentProviderError("unavailable", timedOut ? `Biteship ${kind} request timed out` : `Biteship ${kind} request failed`, {
          cause: error,
          outcomeUnknown: opts.write,
        });
      }
      if (response.status >= 500 && opts.retry && attempt === 1) {
        console.warn(`[shipping] Biteship ${kind} answered ${response.status}; retrying once`);
        await response.body?.cancel();
        await delay(readRetryDelayMs);
        continue;
      }
      let json: unknown = null;
      let isJson = true;
      try {
        json = await response.json();
      } catch (error) {
        // Also a timeout while the body was still arriving: the caller decides by status.
        isJson = false;
        if (isTimeoutError(error)) console.warn(`[shipping] Biteship ${kind} answer body timed out`, { status: response.status });
      }
      return { status: response.status, json, isJson };
    }
  }

  function orderUrl(providerOrderId: string, suffix = ""): URL {
    // Our own stored id is wrong: a programming or data error, never "Biteship has no such order".
    if (!PROVIDER_ORDER_ID.test(providerOrderId)) throw new RangeError("Biteship order id has an unexpected shape");
    return joinUrl(options.baseUrl, `v1/orders/${encodeURIComponent(providerOrderId)}${suffix}`);
  }

  return {
    name: "biteship",

    async createShipment(input: CreateShipmentInput): Promise<ProviderShipment> {
      const body = biteshipOrderRequestBody(input);
      const { status, json, isJson } = await send(
        "order_writes",
        joinUrl(options.baseUrl, "v1/orders"),
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
        { timeoutMs: options.createTimeoutMs ?? BITESHIP_CREATE_TIMEOUT_MS, retry: false, write: true },
      );
      if (status === 200 || status === 201) {
        const order = parseBiteshipOrder(json);
        // Booked, but we cannot read what: re-sending the reference recovers the order id.
        if (!order) {
          throw new ShipmentProviderError("bad_response", `Biteship booking answered ${status} ${isJson ? "with an unexpected shape" : "with a non-JSON body"}`, {
            status,
            outcomeUnknown: true,
          });
        }
        if (order.referenceId !== null && order.referenceId !== input.referenceId) {
          throw new ShipmentProviderError("bad_response", "Biteship booking answered with another reference id", { status, outcomeUnknown: true });
        }
        return order;
      }
      const envelope = readErrorEnvelope(json);
      const providerCode = envelope.code;
      if (providerCode === BITESHIP_DUPLICATE_REFERENCE_CODE) {
        throw new ShipmentProviderError("duplicate_reference", "Biteship reference id was already used", {
          status,
          providerCode,
          outcomeUnknown: true,
          existingOrderId: envelope.existingOrderId,
        });
      }
      if (status >= 500) {
        throw new ShipmentProviderError("unavailable", `Biteship booking answered ${status}`, { status, providerCode, outcomeUnknown: true });
      }
      if (TRANSIENT_4XX.has(status) || status === 404) {
        throw new ShipmentProviderError("unavailable", `Biteship booking answered ${status}`, { status, providerCode });
      }
      // Only Biteship's own error envelope is a definite "nothing was booked"; any other 4xx (a
      // proxy page, an odd body) might hide a duplicate reference.
      if (status >= 400 && envelope.parsed) {
        throw new ShipmentProviderError("refused", `Biteship refused the booking (${status})`, { status, providerCode });
      }
      throw new ShipmentProviderError("bad_response", `Biteship booking answered ${status} without its error format`, { status, providerCode, outcomeUnknown: true });
    },

    async getShipment(providerOrderId: string): Promise<ProviderShipment> {
      const { status, json, isJson } = await send("orders", orderUrl(providerOrderId), { method: "GET" }, {
        timeoutMs: options.readTimeoutMs ?? BITESHIP_READ_TIMEOUT_MS,
        retry: true,
        write: false,
      });
      if (status === 200) {
        const order = parseBiteshipOrder(json);
        if (!order) {
          throw new ShipmentProviderError("bad_response", `Biteship order answered 200 ${isJson ? "with an unexpected shape" : "with a non-JSON body"}`, { status });
        }
        if (order.providerOrderId !== providerOrderId) {
          throw new ShipmentProviderError("bad_response", "Biteship order answered for another order id", { status });
        }
        return order;
      }
      const providerCode = readErrorEnvelope(json).code;
      if (status === 404) throw new ShipmentProviderError("not_found", "Biteship has no such order", { status, providerCode });
      throw new ShipmentProviderError("unavailable", `Biteship order answered ${status}`, { status, providerCode });
    },

    async cancelShipment(providerOrderId: string, input: CancelShipmentInput): Promise<CancelledShipment> {
      const reason = cleanText(input.reason, 200);
      const { status, json } = await send(
        "order_writes",
        orderUrl(providerOrderId, "/cancel"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cancellation_reason_code: input.reasonCode, ...(reason ? { cancellation_reason: reason } : {}) }),
        },
        { timeoutMs: options.cancelTimeoutMs ?? BITESHIP_CANCEL_TIMEOUT_MS, retry: false, write: true },
      );
      if (status === 200) {
        const body = z.object({ success: z.literal(true), id: z.unknown().optional(), status: z.unknown().optional() }).safeParse(json);
        // Probably cancelled, but unreadable: the caller reads the order before deciding.
        if (!body.success) throw new ShipmentProviderError("bad_response", "Biteship cancel answered 200 with an unexpected shape", { status, outcomeUnknown: true });
        if (body.data.id !== undefined && body.data.id !== providerOrderId) {
          throw new ShipmentProviderError("bad_response", "Biteship cancel answered for another order id", { status, outcomeUnknown: true });
        }
        const rawStatus = cleanText(body.data.status, 100);
        return { providerOrderId, providerStatus: rawStatus ? (canonicalBiteshipStatus(rawStatus) ?? rawStatus) : null };
      }
      const envelope = readErrorEnvelope(json);
      const providerCode = envelope.code;
      if (providerCode === BITESHIP_NOT_CANCELLABLE_CODE) {
        throw new ShipmentProviderError("not_cancellable", "Biteship refuses the cancel for the order's status", { status, providerCode });
      }
      if (status === 404) throw new ShipmentProviderError("not_found", "Biteship has no such order", { status, providerCode });
      if (status >= 500) throw new ShipmentProviderError("unavailable", `Biteship cancel answered ${status}`, { status, providerCode, outcomeUnknown: true });
      if (TRANSIENT_4XX.has(status) || (providerCode !== undefined && BITESHIP_CANCEL_RETRYABLE_CODES.has(providerCode))) {
        throw new ShipmentProviderError("unavailable", `Biteship cancel answered ${status}`, { status, providerCode });
      }
      if (status >= 400 && envelope.parsed) throw new ShipmentProviderError("refused", `Biteship refused the cancel (${status})`, { status, providerCode });
      throw new ShipmentProviderError("bad_response", `Biteship cancel answered ${status} without its error format`, { status, providerCode, outcomeUnknown: true });
    },
  };
}
