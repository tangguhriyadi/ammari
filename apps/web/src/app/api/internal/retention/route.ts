import { runRetention, withExclusiveRun } from "@ammari/commerce/maintenance";
import { defaultDb } from "@/lib/db";
import { errorLogFields } from "@ammari/commerce/errors";
import { authorizeCronRequest, cronJson } from "@/lib/internal/cron-auth";

// The daily retention job (docs/plans/cart-checkout.md §11): `POST /api/internal/retention`,
// called once a day by the internal cron service (see lib/internal/cron-auth.ts). Not behind
// STOREFRONT_CART_ENABLED: the rate-limit rows it prunes are written with the flag off too. One run
// at a time (advisory lock). Answers 200 with the deleted counts, or 500 when any table failed (the
// others still ran; the next day's run retries).

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeCronRequest(request, "retention");
  if (!auth.ok) return auth.response;

  try {
    const run = await withExclusiveRun(defaultDb, "retention", () => runRetention(defaultDb));
    if (!run.ran) {
      console.info("[retention] skipped: another run holds the lock");
      return cronJson(200, { skipped: "running" });
    }
    const summary = run.value;
    console.info("[retention] done", summary);
    return cronJson(summary.failed.length > 0 ? 500 : 200, summary);
  } catch (error) {
    console.error("[retention] failed; retried on the next run", errorLogFields(error));
    return cronJson(500, { error: "retention failed" });
  }
}
