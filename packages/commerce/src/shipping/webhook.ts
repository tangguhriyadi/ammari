import "server-only";
import { eq, sql } from "drizzle-orm";
import { shipments, shippingWebhookEvents } from "@ammari/db/schema";
import type { Database } from "../db";
import { errorLogFields, isPostgresErrorCode } from "../errors";
import type { OrderStatus } from "@ammari/db/schema";
import { refetchShipmentForWebhook, type ShipmentReader, type ShipmentReadOutcome } from "./tracking";

// The courier webhook (docs/plans/cart-checkout.md §15 Phase K "Webhook vs polling", decision 48).
// Biteship signs nothing and retries nothing, so a post is only a hint: after the route has checked
// its path token and static header secret, the body is logged as sent (`shipping_webhook_events`,
// 12 months) and the order it names, if it is one of ours, is re-fetched from Biteship (at most once
// per shipment every 2 minutes) and only that answer is applied. Nothing in the body itself is ever
// acted on.

/** Bodies larger than this are not read (Biteship's payloads are a few hundred bytes). */
export const SHIPPING_WEBHOOK_MAX_BYTES = 16 * 1024;
/** A body that is not JSON is kept as text, this long at most. */
const RAW_TEXT_MAX = 4_000;
/** Biteship order ids in every example are 24 hex characters; the client accepts this shape. */
const PROVIDER_ORDER_ID = /^[A-Za-z0-9_-]{1,100}$/;
const EVENT_MAX = 100;

export interface ParsedShippingWebhook {
  /** The parsed JSON body, or null (empty or not JSON). */
  payload: unknown;
  /** The body as text when it is not JSON (capped), otherwise null. */
  rawText: string | null;
  event: string | null;
  providerOrderId: string | null;
}

/** Reads what a Biteship webhook body names (`event`, `order_id`), leniently: an odd or empty body
 * is still logged, it just names nothing. NUL characters are dropped (Postgres text and jsonb refuse
 * them, and the row must still be written). */
export function parseShippingWebhookBody(text: string): ParsedShippingWebhook {
  const clean = text.replace(/\u0000/g, "");
  if (clean.trim() === "") return { payload: null, rawText: null, event: null, providerOrderId: null };
  let payload: unknown;
  try {
    payload = JSON.parse(clean);
  } catch {
    return { payload: null, rawText: clean.slice(0, RAW_TEXT_MAX), event: null, providerOrderId: null };
  }
  const record = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const event = typeof record.event === "string" && record.event.trim() !== "" ? record.event.trim().slice(0, EVENT_MAX) : null;
  const rawId = typeof record.order_id === "string" ? record.order_id.trim() : "";
  return { payload, rawText: null, event, providerOrderId: PROVIDER_ORDER_ID.test(rawId) ? rawId : null };
}

/** Postgres refuses these in jsonb (`22P05` untranslatable character: an escaped NUL; `22P02`
 * invalid input: a lone surrogate escape) even though JSON.parse accepted them. */
const JSONB_REFUSALS = ["22P05", "22P02"];

/** Logs one authenticated webhook post. A payload jsonb refuses (an escaped NUL or a lone surrogate
 * inside a string) is kept as cleaned text instead, so the row and the re-fetch are never lost.
 * Throws only when the row cannot be written at all (database down). */
export async function recordShippingWebhook(db: Database, parsed: ParsedShippingWebhook, bodyBytes: number): Promise<{ id: string }> {
  // Each attempt in its own (sub)transaction: a refused insert inside a caller's transaction would
  // otherwise abort it for the retry too.
  const insert = (payload: unknown, rawText: string | null) =>
    db.transaction((tx) =>
      tx
        .insert(shippingWebhookEvents)
      .values({
        event: parsed.event,
        providerOrderId: parsed.providerOrderId,
        // jsonb null for an empty body: the column stays NULL rather than holding a JSON null.
        payload: payload === null ? null : (payload as object),
        rawText,
        bodyBytes,
      })
        .returning({ id: shippingWebhookEvents.id }),
    );
  let rows: { id: string }[];
  try {
    rows = await insert(parsed.payload, parsed.rawText);
  } catch (error) {
    if (parsed.payload === null || !JSONB_REFUSALS.some((code) => isPostgresErrorCode(error, code))) throw error;
    console.warn("[shipping] webhook payload refused as jsonb; kept as text", { event: parsed.event, providerOrderId: parsed.providerOrderId });
    const text = JSON.stringify(parsed.payload).replace(/\\u0000/g, "").slice(0, RAW_TEXT_MAX);
    rows = await insert(null, text);
  }
  const [row] = rows;
  if (!row) throw new Error("webhook event insert returned nothing");
  return row;
}

export type ShippingWebhookResult =
  /** The body named no order id (an install check, an odd body). */
  | "no_order_id"
  /** No shipment of ours has that Biteship order id (another environment's order, or a booking whose
   * answer was lost: staff's "Cek ulang" settles those). */
  | "unknown_order"
  | ShipmentReadOutcome;

export interface ShippingWebhookOutcome {
  result: ShippingWebhookResult;
  /** Set when the re-fetch moved the order: the caller sends what emails are due. */
  orderNo: string | null;
  orderTransitions: OrderStatus[];
}

/** Processes one logged post: finds the shipment, re-fetches it (debounced), applies the answer, and
 * records the result on the log row. Never throws (it runs after the 200 has been sent); every
 * problem is logged and recorded as the result. */
export async function processShippingWebhook(db: Database, reader: ShipmentReader | null, event: { id: string; providerOrderId: string | null }): Promise<ShippingWebhookOutcome> {
  let outcome: ShippingWebhookOutcome = { result: "no_order_id", orderNo: null, orderTransitions: [] };
  let shipmentId: string | null = null;
  try {
    if (event.providerOrderId !== null) {
      const [shipment] = await db.select({ id: shipments.id }).from(shipments).where(eq(shipments.providerOrderId, event.providerOrderId)).limit(1);
      if (!shipment) {
        // Biteship's order id is not personal data; it lets the owner find the order in the dashboard.
        console.info("[shipping] webhook for an order that is not ours; nothing fetched", { eventId: event.id, providerOrderId: event.providerOrderId });
        outcome = { result: "unknown_order", orderNo: null, orderTransitions: [] };
      } else {
        shipmentId = shipment.id;
        const read = await refetchShipmentForWebhook(db, reader, shipment.id);
        outcome = { result: read.outcome, orderNo: read.applied?.orderNo ?? null, orderTransitions: read.applied?.orderTransitions ?? [] };
        if (!reader) console.error("[shipping] webhook re-fetch skipped: courier tracking is not configured; the poller reads it once it is", { eventId: event.id, shipmentId });
      }
    }
  } catch (error) {
    console.error("[shipping] webhook processing failed; the poller reads the shipment later", { eventId: event.id, shipmentId, ...errorLogFields(error) });
    outcome = { result: "failed", orderNo: null, orderTransitions: [] };
  }
  try {
    await db
      .update(shippingWebhookEvents)
      .set({ shipmentId, processedAt: sql`now()`, result: outcome.result })
      .where(eq(shippingWebhookEvents.id, event.id));
  } catch (error) {
    console.error("[shipping] could not record the webhook result", { eventId: event.id, result: outcome.result, ...errorLogFields(error) });
  }
  return outcome;
}
