import { runPostingExclusive } from "@ammari/accounting/runner";
import { withExclusiveRun } from "@ammari/commerce/maintenance";
import { errorLogFields } from "@ammari/commerce/errors";
import { defaultDb } from "@/lib/db";
import { authorizeCronRequest, cronJson } from "@/lib/internal/cron-auth";

// The accounting posting cron (docs/plans/accounting.md §2, §8 Session 12): `POST
// /api/internal/accounting/posting`, called every 15 minutes by the internal cron service
// (deploy/cron/cron.sh, deploy-prod/cron/cron.sh; see lib/internal/cron-auth.ts for who may call it).
// The posting runner only reads source records and writes journal tables (the ledger is derived,
// plan §2), so it changes no order, payment, stock or shipping row.
//
// Two locks, both try-locks that never wait: the shared cron lock (withExclusiveRun, so it never
// overlaps the sweep or the email pass) and the posting run lock (runPostingExclusive, shared with
// "Posting sekarang" in admin, so the cron and a staff member never scan at the same time). Either
// one busy answers 200 `{ skipped: ... }`. Answers 200 with the run's counts; 500 when a posting key
// failed to write (recorded as a `posting_failed` issue; the next run retries) or the run itself
// failed (marked failed in posting_runs). Ordinary posting issues (an unmapped category, a missing
// marketplace ship date) are the bookkeeper's work queue, not a cron failure: still 200.

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeCronRequest(request, "accounting_posting");
  if (!auth.ok) return auth.response;

  try {
    const cron = await withExclusiveRun(defaultDb, "accountingPosting", () => runPostingExclusive(defaultDb, { trigger: "cron" }));
    if (!cron.ran) {
      console.info("[accounting] posting cron skipped: another cron job holds the lock");
      return cronJson(200, { skipped: "running" });
    }
    const run = cron.value;
    if (!run.ran) {
      console.info("[accounting] posting cron skipped: a posting run is already in progress");
      return cronJson(200, { skipped: "posting_in_progress" });
    }
    const { result, staleRunsClosed } = run;
    const body = {
      runId: result.runId,
      inserted: result.insertedCount,
      reversed: result.reversedCount,
      unchanged: result.unchangedCount,
      issues: result.issueCount,
      failed: result.failedCount,
      staleRunsClosed,
    };
    if (result.failedCount > 0) {
      console.error("[accounting] posting cron: some keys failed to post; retried on the next run", body);
      return cronJson(500, body);
    }
    if (result.insertedCount > 0 || result.reversedCount > 0 || staleRunsClosed > 0) console.info("[accounting] posting cron done", body);
    return cronJson(200, body);
  } catch (error) {
    console.error("[accounting] posting cron failed; retried on the next run", errorLogFields(error));
    return cronJson(500, { error: "posting failed" });
  }
}
