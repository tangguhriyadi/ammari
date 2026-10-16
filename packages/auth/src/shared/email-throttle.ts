import { sql } from "drizzle-orm";
import type { db as defaultDb } from "@ammari/db";
import { authEmailThrottle } from "@ammari/db/schema";

export type Database = typeof defaultDb;

// Comfortably longer than any window below (per-email cap 5 min, global cap 1 hour) — this
// table only needs to remember "how many/how recent were sends in the last N seconds," never
// anything older than the longest window any caller asks about.
const RETENTION_SECONDS = 60 * 60 * 24; // 1 day
// Runs the cleanup delete on roughly 1 in 20 calls rather than every call — this table is
// write-heavy (one row per OTP-send attempt, including throttled/unknown-email ones) and a
// delete on every single insert would be wasted work almost every time. Low enough overhead,
// high enough frequency that rows never meaningfully pile up.
const CLEANUP_PROBABILITY = 0.05;

export interface EmailThrottleWindows {
  /** A send for this SAME email within the last `cooldownSeconds` blocks this one (silent
   * no-op) — the per-email resend cooldown. */
  cooldownSeconds: number;
  /** Sends for this SAME email within the last `capWindowSeconds`, counting this one, must stay
   * at or under the caller's own max — the per-email "N sends per window" cap. */
  capWindowSeconds: number;
  /** Sends for ANY email within the last `globalWindowSeconds` — the whole-system circuit
   * breaker, shared across both the staff and customer instances (same physical table). */
  globalWindowSeconds: number;
}

export interface EmailThrottleDecision {
  /** true if a send for this email was recorded within `cooldownSeconds` — the caller should
   * skip sending (same silent-no-op shape as every other throttle outcome here). */
  cooldownActive: boolean;
  /** Count of sends for this email within `capWindowSeconds`, NOT including the row this call
   * itself just inserted (see the function's own doc comment for why). */
  priorAttemptsInCapWindow: number;
  /** Count of sends for ANY email within `globalWindowSeconds`, NOT including the row this call
   * itself just inserted. */
  priorGlobalAttempts: number;
}

/** One row per OTP-send attempt (see schema/auth-throttle.ts for why this can't be derived from
 * Better Auth's own verification table) — records the attempt AND atomically returns everything
 * needed to decide whether to actually send: whether the per-email cooldown is still active, how
 * many prior attempts this email has within its cap window, and how many prior attempts ANY
 * email has within the global window. Shared by BOTH the staff and customer Better Auth
 * instances (see schema/auth-throttle.ts's own doc comment) — hoisted here rather than
 * duplicated per instance.
 *
 * All three counts/checks come from the SAME single `INSERT ... RETURNING`, so they all see the
 * identical pre-insert snapshot — no risk of the cooldown and cap checks disagreeing about which
 * rows existed "before this attempt." None of the returned counts include the row this call just
 * inserted: a RETURNING subquery runs against the command's own starting snapshot, which — per
 * Postgres's normal MVCC rule that a statement doesn't see its own effects — excludes the row
 * the outer INSERT is still in the middle of writing. Callers must treat each count as "prior
 * attempts," i.e. block once a value reaches its limit, not once it exceeds it.
 *
 * Deliberately not a separate "count, then decide, then insert" — per CLAUDE.md, anything that
 * can happen concurrently must not be check-then-write. Two concurrent requests for the same
 * email each run this as one atomic INSERT ... RETURNING; the only remaining imprecision is
 * truly-simultaneous requests not yet seeing each other's uncommitted insert under READ
 * COMMITTED, which can undercount by at most one per overlapping batch — an accepted, standard
 * tolerance for a rate limiter, unlike the previous unbounded-overcount race. */
export async function recordEmailThrottleAttempt(
  db: Database,
  email: string,
  windows: EmailThrottleWindows,
): Promise<EmailThrottleDecision> {
  const [row] = await db
    .insert(authEmailThrottle)
    .values({ email })
    .returning({
      cooldownActive: sql<boolean>`exists(
        select 1 from ${authEmailThrottle}
        where ${authEmailThrottle.email} = ${email}
          and ${authEmailThrottle.createdAt} > now() - make_interval(secs => ${windows.cooldownSeconds})
      )`,
      priorAttemptsInCapWindow: sql<number>`(
        select count(*) from ${authEmailThrottle}
        where ${authEmailThrottle.email} = ${email}
          and ${authEmailThrottle.createdAt} > now() - make_interval(secs => ${windows.capWindowSeconds})
      )`,
      priorGlobalAttempts: sql<number>`(
        select count(*) from ${authEmailThrottle}
        where ${authEmailThrottle.createdAt} > now() - make_interval(secs => ${windows.globalWindowSeconds})
      )`,
    });
  await cleanupOldThrottleRows(db);
  return {
    cooldownActive: Boolean(row?.cooldownActive),
    priorAttemptsInCapWindow: Number(row?.priorAttemptsInCapWindow ?? 1),
    priorGlobalAttempts: Number(row?.priorGlobalAttempts ?? 1),
  };
}

/** Opportunistic pruning (CLAUDE.md: a throttle table must not grow forever) — most calls are a
 * no-op; the rest delete everything older than `RETENTION_SECONDS`, which the table's own
 * `created_at` index (schema/auth-throttle.ts) serves directly since this filter has no other
 * column to narrow by. */
async function cleanupOldThrottleRows(db: Database): Promise<void> {
  if (Math.random() >= CLEANUP_PROBABILITY) return;
  await db.delete(authEmailThrottle).where(sql`${authEmailThrottle.createdAt} < now() - make_interval(secs => ${RETENTION_SECONDS})`);
}
