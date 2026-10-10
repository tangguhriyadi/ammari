import { sql } from "drizzle-orm";
import type { db as defaultDb } from "@ammari/db";
import { authEmailThrottle } from "@ammari/db/schema";

export type Database = typeof defaultDb;

// Comfortably longer than any OTP-send throttle window either instance configures (staff and
// customer both use 5 minutes) — this table only needs to remember "how many sends in the last
// N seconds," never anything older than that.
const RETENTION_SECONDS = 60 * 60 * 24; // 1 day
// Runs the cleanup delete on roughly 1 in 20 calls rather than every call — this table is
// write-heavy (one row per OTP-send attempt, including throttled/unknown-email ones) and a
// delete on every single insert would be wasted work almost every time. Low enough overhead,
// high enough frequency that rows never meaningfully pile up.
const CLEANUP_PROBABILITY = 0.05;

/** One row per OTP-send attempt (see schema/auth-throttle.ts for why this can't be derived from
 * Better Auth's own verification table) — records the attempt AND atomically returns how many
 * OTHER attempts already exist for `email` within `windowSeconds`, in a single SQL statement.
 * Shared by BOTH the staff and customer Better Auth instances (see schema/auth-throttle.ts's own
 * doc comment) — hoisted here rather than duplicated per instance.
 *
 * The returned count does NOT include the row this call just inserted: a RETURNING subquery
 * over the same table runs against the command's own starting snapshot, which — per Postgres's
 * normal MVCC rule that a statement doesn't see its own effects — excludes the row the outer
 * INSERT is still in the middle of writing. Callers must treat the result as "prior attempts,"
 * i.e. block once this value reaches the limit, not once it exceeds it.
 *
 * Deliberately not a separate "count, then decide, then insert" — per CLAUDE.md, anything that
 * can happen concurrently must not be check-then-write. Two concurrent requests for the same
 * email each run this as one atomic INSERT ... RETURNING; the only remaining imprecision is
 * truly-simultaneous requests not yet seeing each other's uncommitted insert under READ
 * COMMITTED, which can undercount by at most one per overlapping batch — an accepted, standard
 * tolerance for a rate limiter, unlike the previous unbounded-overcount race. */
export async function recordEmailThrottleAttemptAndCount(
  db: Database,
  email: string,
  windowSeconds: number,
): Promise<number> {
  const [row] = await db
    .insert(authEmailThrottle)
    .values({ email })
    .returning({
      count: sql<number>`(
        select count(*) from ${authEmailThrottle}
        where ${authEmailThrottle.email} = ${email}
          and ${authEmailThrottle.createdAt} > now() - make_interval(secs => ${windowSeconds})
      )`,
    });
  await cleanupOldThrottleRows(db);
  return Number(row?.count ?? 1);
}

/** Opportunistic pruning (CLAUDE.md: a throttle table must not grow forever) — most calls are a
 * no-op; the rest delete everything older than `RETENTION_SECONDS`, which the table's own
 * `created_at` index (schema/auth-throttle.ts) serves directly since this filter has no other
 * column to narrow by. */
async function cleanupOldThrottleRows(db: Database): Promise<void> {
  if (Math.random() >= CLEANUP_PROBABILITY) return;
  await db.delete(authEmailThrottle).where(sql`${authEmailThrottle.createdAt} < now() - make_interval(secs => ${RETENTION_SECONDS})`);
}
