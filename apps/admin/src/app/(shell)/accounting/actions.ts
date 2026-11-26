"use server";

import { runPosting } from "@ammari/accounting/runner";
import type { ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { defaultDb } from "@/lib/db";

// "Posting sekarang" (docs/plans/accounting.md §2: cron + a button; the cron route is Session 12).
// accounting.manage runs posting (plan §7); accounting.view because the button lives on the
// ledger pages. The run itself is recorded in posting_runs with who started it.

export interface PostingRunSummary {
  insertedCount: number;
  reversedCount: number;
  issueCount: number;
}

export async function runPostingAction(): Promise<ActionResult<PostingRunSummary>> {
  const session = await requireAllPermissions(["accounting.view", "accounting.manage"]);
  try {
    const result = await runPosting(defaultDb, { trigger: "manual", triggeredByStaffUserId: session.staffUser.id });
    revalidateAdmin("/accounting");
    return { ok: true, data: { insertedCount: result.insertedCount, reversedCount: result.reversedCount, issueCount: result.issueCount } };
  } catch (error) {
    // The run is already marked failed in posting_runs with the error; the browser only gets a
    // plain message (Next redacts thrown errors in production anyway).
    console.error("[accounting] posting run failed", error);
    return { ok: false, error: "Posting gagal. Coba lagi beberapa saat lagi." };
  }
}
