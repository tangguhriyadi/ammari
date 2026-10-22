import { errorLogFields } from "@ammari/commerce/errors";
import { withExclusiveRun } from "@ammari/commerce/maintenance";
import { pollShipments } from "@ammari/commerce/shipping";
import { defaultDb } from "@/lib/db";
import { scheduleOrderEmails } from "@/lib/emails/order-emails";
import { authorizeCronRequest, cronJson } from "@/lib/internal/cron-auth";
import { getTrackingReader } from "@/lib/shipping/tracking-runtime";

// The courier tracking poller (docs/plans/cart-checkout.md §15 Phase K, decision 48, K3): `POST
// /api/internal/shipping/poll`, called every 3 hours by the internal cron service (see
// lib/internal/cron-auth.ts for who may call it). The backstop for webhooks Biteship never retries:
// flags `tracking_stale` (no pickup in 2 days, no courier event in 5), then reads every shipment a
// webhook asked to re-read, every one still waiting for pickup, and any other open one whose last
// event and last read are both older than 6 hours, within the shared daily `shipping_orders`
// budget. Orders it moves get their emails after the answer. Not behind STOREFRONT_CART_ENABLED.
// One cron job at a time (the shared advisory lock). Answers: 200; 503 when tracking is not
// configured (the stale pass still ran); 429 when the daily read budget ran out (reads wait until
// tomorrow, the shipments not reached show why on the admin order page); 502 when Biteship could not
// be reached; 500 when a read failed for good or the run failed. Every non-2xx is an ERROR line in
// the cron log.

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeCronRequest(request, "shipment_poll");
  if (!auth.ok) return auth.response;

  try {
    const reader = getTrackingReader();
    const run = await withExclusiveRun(defaultDb, "shipmentPoll", () => pollShipments(defaultDb, reader));
    if (!run.ran) {
      console.info("[shipping] poll skipped: another cron job holds the lock");
      return cronJson(200, { skipped: "running" });
    }
    const summary = run.value;
    scheduleOrderEmails(
      summary.changedOrderNos.map((orderNo) => ({ orderNo })),
      "shipment poll",
    );
    if (summary.budgetExhausted) console.error("[shipping] poll stopped: the daily Biteship order read budget is used up; tracking waits until tomorrow", summary);
    else if (summary.candidates > 0 || summary.staleFlagged > 0) console.info("[shipping] poll done", summary);
    const outcomes = summary.outcomes;
    const status = summary.notConfigured ? 503 : summary.budgetExhausted ? 429 : outcomes.failed ? 500 : outcomes.unavailable ? 502 : 200;
    return cronJson(status, summary.notConfigured ? { error: "courier tracking not configured", ...summary } : summary);
  } catch (error) {
    console.error("[shipping] poll failed; retried on the next run", errorLogFields(error));
    return cronJson(500, { error: "poll failed" });
  }
}
