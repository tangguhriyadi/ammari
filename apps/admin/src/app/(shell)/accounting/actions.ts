"use server";

import { runPostingExclusive } from "@ammari/accounting/runner";
import type { ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { defaultDb } from "@/lib/db";

// "Posting sekarang" (docs/plans/accounting.md §2: cron + a button). accounting.manage runs posting
// (plan §7); accounting.view because the button lives on the ledger pages. The run itself is
// recorded in posting_runs with who started it. Session 12: under the run-level lock shared with
// the cron route (apps/web /api/internal/accounting/posting), so while the cron is posting the
// button says so instead of running a second scan.

export interface PostingRunSummary {
  insertedCount: number;
  reversedCount: number;
  issueCount: number;
}

const POSTING_BUSY_MESSAGE = "Posting sedang berjalan (otomatis atau dari staf lain). Tunggu sebentar lalu muat ulang halaman ini.";

export async function runPostingAction(): Promise<ActionResult<PostingRunSummary>> {
  const session = await requireAllPermissions(["accounting.view", "accounting.manage"]);
  try {
    const run = await runPostingExclusive(defaultDb, { trigger: "manual", triggeredByStaffUserId: session.staffUser.id });
    if (!run.ran) return { ok: false, error: POSTING_BUSY_MESSAGE };
    const { result } = run;
    revalidateAdmin("/accounting");
    return { ok: true, data: { insertedCount: result.insertedCount, reversedCount: result.reversedCount, issueCount: result.issueCount } };
  } catch (error) {
    // The run is already marked failed in posting_runs with the error; the browser only gets a
    // plain message (Next redacts thrown errors in production anyway).
    console.error("[accounting] posting run failed", error);
    return { ok: false, error: "Posting gagal. Coba lagi beberapa saat lagi." };
  }
}
