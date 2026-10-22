import { after } from "next/server";
import { errorLogFields } from "@ammari/commerce/errors";
import { SHIPPING_WEBHOOK_MAX_BYTES, parseShippingWebhookBody, processShippingWebhook, recordShippingWebhook, type ParsedShippingWebhook } from "@ammari/commerce/shipping";
import { defaultDb } from "@/lib/db";
import { scheduleOrderEmails } from "@/lib/emails/order-emails";
import { readCappedBody } from "@/lib/http/capped-body";
import { getTrackingReader } from "@/lib/shipping/tracking-runtime";
import { authorizeWebhook, webhookSecretsFromEnv } from "@/lib/shipping/webhook-auth";

// The courier webhook (docs/plans/cart-checkout.md §15 Phase K "Webhook vs polling", decision 48,
// K3): `POST /api/shipping/biteship/webhook/<BITESHIP_WEBHOOK_PATH_TOKEN>`, registered in the
// Biteship dashboard with the static header BITESHIP_WEBHOOK_HEADER_NAME:
// BITESHIP_WEBHOOK_HEADER_SECRET (lib/shipping/webhook-auth.ts). Biteship signs nothing and never
// retries, so:
// - Every POST is answered 200 at once with the same body (an empty or odd body, a wrong token or
//   header, a database outage, missing configuration too): the answer never tells a caller anything.
// - Only a post that passes both checks is logged (`shipping_webhook_events`, raw payload up to
//   16 KB, kept 12 months); anything else is one log line without the body.
// - After the answer (`after()`), the Biteship order the body names, if it is one of our shipments,
//   is re-fetched from Biteship (at most once per shipment every 2 minutes, within the daily
//   `shipping_orders` budget) and only that answer is applied (@ammari/commerce/shipping
//   processShippingWebhook). Then the emails the order now needs go out ("sudah dikirim", "sudah
//   sampai").
// Not behind STOREFRONT_CART_ENABLED: it only acts on bookings that already exist. Never cached.
// Caddy routes this path on the public host (only /api/internal/*, /api/test/* and /api/revalidate
// are refused there); on dev, Cloudflare Access needs a bypass for it (runbook).

export const dynamic = "force-dynamic";

function ok(): Response {
  return new Response("ok", { status: 200, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
}

let loggedConfigProblems: string | null = null;

export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  let parsed: ParsedShippingWebhook | null = null;
  try {
    const config = webhookSecretsFromEnv(process.env);
    if (!config.ok) {
      const signature = config.problems.join("|");
      if (signature !== loggedConfigProblems) {
        console.error("[shipping] courier webhook not configured; posts are ignored until it is (the poller still runs)", { problems: config.problems });
        loggedConfigProblems = signature;
      }
      return ok();
    }
    loggedConfigProblems = null;

    const { token } = await context.params;
    const auth = authorizeWebhook(config.secrets, token, request.headers);
    if (!auth.ok) {
      // Never the token, the header value or the body.
      console.warn("[shipping] courier webhook refused", { failed: auth.failed });
      return ok();
    }

    const body = await readCappedBody(request, SHIPPING_WEBHOOK_MAX_BYTES);
    if (!body.ok) {
      console.warn("[shipping] courier webhook body refused before parsing", { reason: body.reason, bytesRead: body.bytesRead });
      return ok();
    }
    const webhookBody = parseShippingWebhookBody(body.text);
    parsed = webhookBody;
    const event = await recordShippingWebhook(defaultDb, webhookBody, body.bytes);
    after(async () => {
      try {
        const outcome = await processShippingWebhook(defaultDb, getTrackingReader(), { id: event.id, providerOrderId: webhookBody.providerOrderId });
        if (outcome.orderNo && outcome.orderTransitions.length > 0) scheduleOrderEmails([{ orderNo: outcome.orderNo }], "shipping webhook");
      } catch (error) {
        console.error("[shipping] courier webhook processing failed; the poller reads the shipment later", { eventId: event.id, ...errorLogFields(error) });
      }
    });
    return ok();
  } catch (error) {
    // The log row could not be written (database down). Biteship never retries, so a 5xx would only
    // fill its Events Log: still 200, and the poller is the backstop.
    // Biteship's order id is not personal data: it says which shipment the lost hint was about.
    console.error("[shipping] courier webhook could not be logged; the poller reads the shipment later", { providerOrderId: parsed?.providerOrderId ?? null, ...errorLogFields(error) });
    return ok();
  }
}
