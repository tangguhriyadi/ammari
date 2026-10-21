import { dispatchPendingOrderEmails } from "@ammari/commerce/emails";
import { errorLogFields } from "@ammari/commerce/errors";
import { withExclusiveRun } from "@ammari/commerce/maintenance";
import { defaultDb } from "@/lib/db";
import { getOrderEmailConfig } from "@/lib/emails/order-emails";
import { authorizeCronRequest, cronJson } from "@/lib/internal/cron-auth";

// The order email pass (docs/plans/cart-checkout.md §8, D14; session 13): `POST
// /api/internal/emails/dispatch`, called by the internal cron service every 5 minutes right after
// the payment sweep (see lib/internal/cron-auth.ts for who may call it). Sends what checkout orders
// changed in the last 48 hours still need: failed sends are retried after a 10-minute lease (for up
// to 23 hours), and state changes made where no email hook runs (staff's "Tandai dikirim" in
// apps/admin) get their email here. Not behind STOREFRONT_CART_ENABLED (orders already placed keep
// their emails after a rollback of the flag). One cron job at a time (the shared advisory lock).
// 503 when emails are not configured (the variable names are in the answer and logged every run);
// 500 when a send failed, was refused for good or was given up, so the cron log marks the run as an
// ERROR.

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeCronRequest(request, "order_emails");
  if (!auth.ok) return auth.response;

  try {
    const { deps, problems } = getOrderEmailConfig();
    if (!deps) {
      // Every run (the cron makes it one line per 5 minutes): emails wait until this is fixed.
      console.error("[emails] dispatch pass refused: order emails not configured", { problems });
      return cronJson(503, { error: "order emails not configured", problems });
    }
    const run = await withExclusiveRun(defaultDb, "orderEmails", () => dispatchPendingOrderEmails(defaultDb, deps));
    if (!run.ran) {
      console.info("[emails] dispatch pass skipped: another cron job holds the lock");
      return cronJson(200, { skipped: "running" });
    }
    const summary = run.value;
    if (summary.abandoned > 0) console.error("[emails] order emails given up after their retries (see order_notifications.error)", { abandoned: summary.abandoned });
    if (summary.noRecipient > 0) console.warn("[emails] owner emails waiting for store_settings.support_email (set it in admin)", { noRecipient: summary.noRecipient });
    if (summary.orders > 0) console.info("[emails] dispatch pass done", summary);
    // Not a 2xx when a send failed, was refused for good or was given up, so the cron log marks the
    // run as an ERROR. A missing owner address is a warning only (it is settings, not an outage).
    return cronJson(summary.failed > 0 || summary.permanent > 0 || summary.abandoned > 0 ? 500 : 200, summary);
  } catch (error) {
    console.error("[emails] dispatch pass failed; retried on the next run", errorLogFields(error));
    return cronJson(500, { error: "dispatch failed" });
  }
}
