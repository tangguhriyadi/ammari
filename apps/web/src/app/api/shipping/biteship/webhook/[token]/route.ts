import { setTimeout as sleep } from "node:timers/promises";
import { after } from "next/server";
import { errorLogFields } from "@ammari/commerce/errors";
import {
  SHIPPING_WEBHOOK_MAX_BYTES,
  describeShippingWebhookBody,
  parseShippingWebhookBody,
  processShippingWebhook,
  recordShippingWebhook,
  type ParsedShippingWebhook,
  type ShippingWebhookOutcome,
} from "@ammari/commerce/shipping";
import { defaultDb } from "@/lib/db";
import { scheduleOrderEmails } from "@/lib/emails/order-emails";
import { readCappedBody } from "@/lib/http/capped-body";
import { getTrackingReader } from "@/lib/shipping/tracking-runtime";
import { authorizeWebhook, webhookSecretsFromEnv, type WebhookAuthFailure } from "@/lib/shipping/webhook-auth";

// The courier webhook (docs/plans/cart-checkout.md §15 Phase K "Webhook vs polling", decision 48,
// K3): `POST /api/shipping/biteship/webhook/<BITESHIP_WEBHOOK_PATH_TOKEN>`, registered in the
// Biteship dashboard with the static header BITESHIP_WEBHOOK_HEADER_NAME:
// BITESHIP_WEBHOOK_HEADER_SECRET (lib/shipping/webhook-auth.ts). Biteship signs nothing and never
// retries, so:
// - Every POST is answered 200 at once with the same body (an empty or odd body, a wrong token or
//   header, a database outage, missing configuration too): the answer never tells a caller anything.
// - Only a post that passes both checks is stored (`shipping_webhook_events`, raw payload up to
//   16 KB, kept 12 months).
// - After the answer (`after()`), the Biteship order the body names, if it is one of our shipments,
//   is re-fetched from Biteship (at most once per shipment every 2 minutes, within the daily
//   `shipping_orders` budget) and only that answer is applied (@ammari/commerce/shipping
//   processShippingWebhook). Biteship sends one post per status step, seconds apart (`allocated`,
//   `picking_up`, `picked`): a post inside the 2-minute window of the read before it waits for the
//   window to end and reads then, otherwise the step that ships the order would wait for the next
//   3-hourly poll (the dev incident of 2026-10-22). Then the emails the order now needs go out
//   ("sudah dikirim", "sudah sampai").
// - Every post gets exactly one `[shipping] courier webhook` log line (logPost below): the auth
//   result, and for an authenticated post the event, whether the shipment is ours, how it was read
//   and the outcome. Never the token, the header value or the body (its claimed status word and, when
//   it names no order id, its field names only).
// Not behind STOREFRONT_CART_ENABLED: it only acts on bookings that already exist. Never cached.
// Caddy routes this path on the public host (only /api/internal/*, /api/test/* and /api/revalidate
// are refused there); on dev, Cloudflare Access needs a bypass for it (runbook).

export const dynamic = "force-dynamic";

function ok(): Response {
  return new Response("ok", { status: 200, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
}

/** `unchecked`: something threw before the checks finished (logged with the error). */
type AuthResult = "ok" | WebhookAuthFailure | "not_configured" | "unchecked";

/** The media type only, and only when it looks like one: the header is the caller's to set. */
function mediaType(headers: Headers): string | null {
  const value = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (value === "") return null;
  return /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60}$/.test(value) ? value : "other";
}

interface PostLog {
  auth: AuthResult;
  contentType: string | null;
  body?: { reason: "too_large" | "unreadable"; bytesRead: number };
  eventId?: string;
  parsed?: ParsedShippingWebhook;
  outcome?: ShippingWebhookOutcome | "not_stored" | "processing_threw";
}

/** The one log line per post. Biteship's order id is not personal data (it lets the owner find the
 * post in Biteship's Events Log); the claimed status is a short word, never acted on. */
function logPost(entry: PostLog): void {
  const description = entry.parsed ? describeShippingWebhookBody(entry.parsed) : null;
  const outcome = entry.outcome;
  const fields = {
    auth: entry.auth,
    contentType: entry.contentType,
    ...(entry.body ? { body: entry.body.reason, bytesRead: entry.body.bytesRead } : {}),
    ...(entry.eventId ? { eventId: entry.eventId } : {}),
    ...(entry.parsed
      ? {
          event: entry.parsed.event,
          format: description!.format,
          claimedStatus: description!.claimedStatus,
          providerOrderId: entry.parsed.providerOrderId,
          ...(description!.keys ? { bodyKeys: description!.keys } : {}),
        }
      : {}),
    ...(outcome === undefined
      ? {}
      : typeof outcome === "string"
        ? { result: outcome }
        : { shipment: outcome.shipmentFound === null ? null : outcome.shipmentFound ? "found" : "not_ours", fetch: outcome.fetch, result: outcome.result, orderTransitions: outcome.orderTransitions }),
  };
  // Warn whenever the order was not brought up to date by this post (it waits for a later poll).
  const failed =
    entry.auth !== "ok" || typeof outcome === "string" || entry.body !== undefined || (outcome !== undefined && ["failed", "unavailable", "budget_exhausted"].includes(outcome.result));
  if (failed) console.warn("[shipping] courier webhook", fields);
  else console.info("[shipping] courier webhook", fields);
}

let loggedConfigProblems: string | null = null;

/** Posts waiting for a read window in this process, by shipment. One waiter per shipment is enough
 * (its read starts after every later post arrived), and at most WAITERS_MAX in all (a burst, or a
 * leaked URL and secret, must not pile up sleepers): the others are left to the poll. */
const waitingShipments = new Set<string>();
const WAITERS_MAX = 50;

async function waitForReadWindow(ms: number, shipmentId: string): Promise<boolean> {
  if (waitingShipments.has(shipmentId) || waitingShipments.size >= WAITERS_MAX) return false;
  waitingShipments.add(shipmentId);
  // A separate line (not the per-post one): a restart while waiting would otherwise leave no trace.
  console.info("[shipping] courier webhook waiting for the read window", { shipmentId, ms });
  try {
    await sleep(ms);
    return true;
  } finally {
    waitingShipments.delete(shipmentId);
  }
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const contentType = mediaType(request.headers);
  let parsed: ParsedShippingWebhook | undefined;
  let authResult: AuthResult = "unchecked";
  try {
    const config = webhookSecretsFromEnv(process.env);
    if (!config.ok) {
      const signature = config.problems.join("|");
      if (signature !== loggedConfigProblems) {
        console.error("[shipping] courier webhook not configured; posts are ignored until it is (the poller still runs)", { problems: config.problems });
        loggedConfigProblems = signature;
      }
      logPost({ auth: "not_configured", contentType });
      return ok();
    }
    loggedConfigProblems = null;

    const { token } = await context.params;
    const auth = authorizeWebhook(config.secrets, token, request.headers);
    if (!auth.ok) {
      logPost({ auth: auth.failed, contentType });
      return ok();
    }
    authResult = "ok";

    const body = await readCappedBody(request, SHIPPING_WEBHOOK_MAX_BYTES);
    if (!body.ok) {
      logPost({ auth: "ok", contentType, body: { reason: body.reason, bytesRead: body.bytesRead } });
      return ok();
    }
    const webhookBody = parseShippingWebhookBody(body.text, request.headers.get("content-type"));
    parsed = webhookBody;
    const event = await recordShippingWebhook(defaultDb, webhookBody, body.bytes);
    after(async () => {
      let outcome: ShippingWebhookOutcome | "processing_threw" = "processing_threw";
      try {
        outcome = await processShippingWebhook(defaultDb, getTrackingReader(), { id: event.id, providerOrderId: webhookBody.providerOrderId }, { waitForReadWindow });
      } catch (error) {
        console.error("[shipping] courier webhook processing failed; the poller reads the shipment later", { eventId: event.id, ...errorLogFields(error) });
      }
      try {
        if (typeof outcome !== "string" && outcome.orderNo && outcome.orderTransitions.length > 0) scheduleOrderEmails([{ orderNo: outcome.orderNo }], "shipping webhook");
      } catch (error) {
        // The order already moved: the poller will not send these.
        console.error("[shipping] courier webhook moved the order but its emails were not scheduled", { eventId: event.id, ...errorLogFields(error) });
      } finally {
        logPost({ auth: "ok", contentType, eventId: event.id, parsed: webhookBody, outcome });
      }
    });
    return ok();
  } catch (error) {
    // The log row could not be written (database down). Biteship never retries, so a 5xx would only
    // fill its Events Log: still 200, and the poller is the backstop.
    console.error("[shipping] courier webhook could not be stored; the poller reads the shipment later", errorLogFields(error));
    logPost({ auth: authResult, contentType, ...(parsed ? { parsed } : {}), outcome: "not_stored" });
    return ok();
  }
}
