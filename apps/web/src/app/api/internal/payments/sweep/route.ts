import { withExclusiveRun } from "@ammari/commerce/maintenance";
import { sweepExpiredPayments } from "@ammari/commerce/payments";
import { defaultDb } from "@/lib/db";
import { errorLogFields } from "@ammari/commerce/errors";
import { authorizeCronRequest, cronJson } from "@/lib/internal/cron-auth";
import { getPaymentProvider } from "@/lib/payments/runtime";
import { revalidateProductPages } from "@/lib/payments/revalidate";

// The payment expiry sweep (docs/plans/cart-checkout.md §6.3, D13): `POST
// /api/internal/payments/sweep`, called every 5 minutes by the internal cron service (see
// lib/internal/cron-auth.ts for who may call it). Deliberately NOT behind STOREFRONT_CART_ENABLED:
// it only acts on checkout orders that already exist, so it does nothing while none do, and after a
// rollback of the flag the orders already placed still expire. One run at a time (advisory lock);
// an overlapping call (this job or the retention job) answers 200 `{ skipped: "running" }`.
// Without a payment provider it answers 503 (nothing can be asked or expired), logged by the
// runtime; 500 / 502 when an order failed or the gateway could not be asked (body still has the
// counts).

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeCronRequest(request, "payment_sweep");
  if (!auth.ok) return auth.response;

  const provider = getPaymentProvider();
  if (!provider) return cronJson(503, { error: "payment provider not configured" });

  try {
    const run = await withExclusiveRun(defaultDb, "paymentSweep", () => sweepExpiredPayments(defaultDb, provider));
    if (!run.ran) {
      console.info("[payments] sweep skipped: another run holds the lock");
      return cronJson(200, { skipped: "running" });
    }
    const summary = run.value;
    revalidateProductPages(summary.productSlugs, { orderNo: null });
    const counts: Record<string, number> = {};
    for (const { result } of summary.results) counts[result] = (counts[result] ?? 0) + 1;
    const body = { candidates: summary.candidates, finalized: summary.finalized, truncated: summary.truncated, stuck: summary.stuck, results: counts };
    if (summary.candidates > 0) console.info("[payments] sweep done", body);
    // Not a 2xx when an order could not be handled, so the cron log marks the run as an ERROR: 500
    // for an unexpected error, 502 when the gateway could not be asked. The orders are retried on
    // the next run either way.
    const status = counts.error ? 500 : counts.gateway_unavailable ? 502 : 200;
    return cronJson(status, body);
  } catch (error) {
    console.error("[payments] sweep failed; retried on the next run", errorLogFields(error));
    return cronJson(500, { error: "sweep failed" });
  }
}
