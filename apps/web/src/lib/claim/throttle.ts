import "server-only";
import { sql } from "drizzle-orm";
import type { db as defaultDb } from "@ammari/db";
import { claimRateLimits } from "@ammari/db/schema";

export type Database = typeof defaultDb;

// Generous enough that a real buyer re-scanning their own card a few times (bad signal, retry,
// showing a friend) never trips it, tight enough to slow down scripted enumeration of the
// token space. The "claim" action gets a tighter limit than "view" — a real claim attempt is a
// much rarer, more deliberate action than loading the page.
export const CLAIM_VIEW_WINDOW_SECONDS = 600;
export const CLAIM_VIEW_LIMIT = 30;
export const CLAIM_SUBMIT_WINDOW_SECONDS = 600;
export const CLAIM_SUBMIT_LIMIT = 10;

// Same retention/cleanup-probability reasoning as packages/auth/src/shared/email-throttle.ts:
// comfortably longer than any window this table's callers configure, and a low per-call
// cleanup probability since this table is write-heavy (one row per view/claim attempt).
const RETENTION_SECONDS = 60 * 60 * 24; // 1 day
const CLEANUP_PROBABILITY = 0.05;

/** One row per claim-endpoint attempt (`/claim/[token]`'s own view, or an actual claim
 * submission) — NOT a Better Auth endpoint, so Better Auth's per-IP limiter
 * (`customer_auth_rate_limits`) doesn't cover it (see schema/claim-throttle.ts). Records the
 * attempt AND atomically returns how many OTHER attempts for this `(ip, action)` already exist
 * within `windowSeconds`, in one SQL statement — same atomic insert+count idiom as
 * `recordEmailThrottleAttemptAndCount`, never a separate count-then-insert (CLAUDE.md). */
export async function recordClaimAttemptAndCount(
  db: Database,
  ip: string,
  action: "view" | "claim",
  windowSeconds: number,
): Promise<number> {
  const [row] = await db
    .insert(claimRateLimits)
    .values({ ip, action })
    .returning({
      count: sql<number>`(
        select count(*) from ${claimRateLimits}
        where ${claimRateLimits.ip} = ${ip}::inet
          and ${claimRateLimits.action} = ${action}
          and ${claimRateLimits.createdAt} > now() - make_interval(secs => ${windowSeconds})
      )`,
    });
  await cleanupOldThrottleRows(db);
  return Number(row?.count ?? 1);
}

async function cleanupOldThrottleRows(db: Database): Promise<void> {
  if (Math.random() >= CLEANUP_PROBABILITY) return;
  await db.delete(claimRateLimits).where(sql`${claimRateLimits.createdAt} < now() - make_interval(secs => ${RETENTION_SECONDS})`);
}
