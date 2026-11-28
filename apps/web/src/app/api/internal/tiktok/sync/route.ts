import { errorLogFields } from "@ammari/commerce/errors";
import { withExclusiveRun } from "@ammari/commerce/maintenance";
import { runTikTokSync, tiktokRuntimeFromEnv, type TikTokSyncSummary } from "@ammari/commerce/tiktok";
import { defaultDb } from "@/lib/db";
import { authorizeCronRequest, cronJson } from "@/lib/internal/cron-auth";

// The TikTok Shop sync cron (docs/plans/tiktok-shop-integration.md §9; T4): `POST
// /api/internal/tiktok/sync`, called every 5 minutes by the internal cron service (deploy/cron/
// cron.sh, deploy-prod/cron/cron.sh; see lib/internal/cron-auth.ts for who may call it). Runs under
// the shared cron lock (withExclusiveRun "tiktokSync"), so it never overlaps the payment sweep, the
// email pass, the tracking poll or the posting run. T4 is READ ONLY: due topic 6/7 events, the token
// refresh, the inbox drain (topics 1/11/12 re-fetch their order) and the reconciliation poll store
// allowlisted snapshots; no admin order, stock or journal changes (T5). T5 applies orders and T6
// returns/cancellations (Search Returns/Cancellations, read only) behind the kill switch. T7 adds the
// finance reads (unsettled transactions, statements, payouts; GET only) every 30 minutes and writes
// the TikTok orders' order_channel_fees.
//
// Answers: 200 with the run's counts (also when no shop is connected: `{ skipped: "not_connected" }`,
// or the lock is held: `{ skipped: "running" }`; a run that ran out of its 150-s budget is 200 too,
// the next run carries on); 503 when the integration is not configured (variable names in the web
// log, never values); 429 when TikTok kept rate limiting; 502 when TikTok was unavailable or not
// reachable; 500 when the shop needs reconnecting, TikTok refused a call, orders of a slice could
// not be stored (`incomplete`: listed but missing, unusable or not storable; the cursor stays and the
// order ids are in the body), or the run failed. Every
// non-2xx is an ERROR line in the cron log. The body holds counts and error codes only.

export const dynamic = "force-dynamic";

let loggedConfigProblems: string | null = null;

function statusFor(summary: TikTokSyncSummary): number {
  if (summary.connection === "reauth_required") return 500;
  // T5: an order whose apply failed with a database or programming error (not a hold, not a busy
  // row) is retried every run, so it must show as an ERROR line and reach the ALERT count.
  if (!summary.error && summary.apply.failed > 0) return 500;
  // T6: the same for a return or cancellation request.
  if (!summary.error && summary.afterSales.failed > 0) return 500;
  // T7: an order's fees that failed to fetch, store or rebuild (retried every finance run).
  if (!summary.error && summary.finance.failed > 0) return 500;
  if (!summary.error) return 200;
  switch (summary.error.kind) {
    case "rate_limited":
      return 429;
    case "unavailable":
    case "network":
      return 502;
    default:
      return 500;
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeCronRequest(request, "tiktok_sync");
  if (!auth.ok) return auth.response;

  const runtime = tiktokRuntimeFromEnv(process.env);
  if (!runtime.ok) {
    const signature = runtime.problems.join("|");
    if (signature !== loggedConfigProblems) {
      console.error("[tiktok] sync not configured", { problems: runtime.problems });
      loggedConfigProblems = signature;
    }
    return cronJson(503, { error: "tiktok not configured" });
  }
  loggedConfigProblems = null;
  const { api, auth: authClient, config } = runtime.runtime;

  try {
    const run = await withExclusiveRun(defaultDb, "tiktokSync", () => runTikTokSync(defaultDb, { api, auth: authClient, keyring: config.tokenKeyring }));
    if (!run.ran) {
      console.info("[tiktok] sync skipped: another cron job holds the lock");
      return cronJson(200, { skipped: "running" });
    }
    const summary = run.value;
    if (summary.connection === "not_connected") return cronJson(200, { skipped: "not_connected", connectionEvents: summary.connectionEvents });
    const status = statusFor(summary);
    // Not failures of this run, but nothing else would show them: a refresh that keeps failing
    // until the token expires, a deauthorization not applied, two versions with the same time, a
    // run that could not catch up (behind, not failing: the next run carries on).
    const attention = summary.tokenRefresh?.startsWith("failed") || summary.connectionEvents.notApplied > 0 || summary.orders.conflicts > 0 || summary.budgetExhausted || summary.inbox.failed > 0 || summary.apply.busy > 0 || summary.apply.notFound > 0 || summary.apply.recheckIncomplete || summary.afterSales.busy > 0 || summary.afterSales.notFound > 0 || summary.afterSales.conflicts > 0 || summary.afterSales.recheckIncomplete || summary.afterSales.invalid > 0 || summary.afterSales.storeFailed > 0 || summary.inbox.retried > 0 || summary.finance.busy > 0 || summary.finance.invalid > 0 || summary.finance.statementsHeld > 0 || summary.finance.orderFeesHeld > 0 || summary.finance.orderFeesMissing > 0 || summary.finance.skipped === "no_scope" || summary.finance.feesHeld > 0 ||
      // T9: a backfill held for a missing scope, or one that got no budget at all this run (starved).
      (summary.backfill.ran && summary.backfill.stoppedBy !== null && (summary.backfill.stoppedBy !== "budget_exhausted" || summary.backfill.orders.pages + summary.backfill.afterSales.pages + summary.backfill.finance.windows === 0));
    if (status !== 200) console.error("[tiktok] sync stopped; the next run retries", summary);
    else if (attention) console.warn("[tiktok] sync done, needs a look", summary);
    else if (summary.orders.fetched > 0 || summary.inbox.claimed > 0 || summary.apply.created + summary.apply.updated > 0 || summary.afterSales.fetched + summary.afterSales.applied > 0 || summary.finance.skipped === null || summary.backfill.ran) console.info("[tiktok] sync done", summary);
    return cronJson(status, summary);
  } catch (error) {
    console.error("[tiktok] sync failed; retried on the next run", errorLogFields(error));
    return cronJson(500, { error: "sync failed" });
  }
}
