import { sql } from "drizzle-orm";
import type { db as defaultDb } from "@ammari/db";
import { authIpThrottle } from "@ammari/db/schema";

export type Database = typeof defaultDb;

// Same reasoning as email-throttle.ts's identical constants — comfortably longer than any window
// a caller passes, low-overhead opportunistic cleanup.
const RETENTION_SECONDS = 60 * 60 * 24; // 1 day
const CLEANUP_PROBABILITY = 0.05;

export interface IpThrottleParams {
  windowSeconds: number;
  max: number;
}

export interface IpThrottleDecision {
  /** true once this IP has made more than `max` attempts within `windowSeconds`, INCLUDING the
   * attempt this call itself just recorded. Unlike `recordEmailThrottleAttempt`'s "prior
   * attempts" counts (which exclude the row just inserted, so callers compare against their own
   * threshold), this is a direct yes/no the caller returns 429 on — there's only ever one
   * threshold here, not several outcomes to pick between. */
  limited: boolean;
}

/** One row per request to a rate-limited read-only endpoint (currently: both apps'
 * `/api/otp-resend-state`), regardless of outcome — a SEPARATE counter from
 * `recordEmailThrottleAttempt`/`auth_email_throttle` (keyed by IP via `auth_ip_throttle`, not by
 * email), same CF-Connecting-IP-header, database-backed-storage approach as the existing per-IP
 * OTP-send abuse guard (createCustomerAuth/createStaffAuth's `OTP_IP_ABUSE_WINDOW_SECONDS`/
 * `OTP_IP_ABUSE_MAX`, enforced by Better Auth's own rate limiter) — see schema/auth-throttle.ts's
 * own doc comment for why this endpoint needs its own counter: it has no OTP of its own to send,
 * so nothing else would ever throttle a caller hammering it to probe whether a given email
 * recently requested a code.
 *
 * Deliberately not a separate "count, then decide, then insert" — per CLAUDE.md, anything that
 * can happen concurrently must not be check-then-write. Same atomic `INSERT ... RETURNING`
 * technique as `recordEmailThrottleAttempt`; see that function's own doc comment for the full
 * reasoning (including why the returned count excludes this row — handled here by adding 1 back
 * before comparing against `max`). */
export async function recordIpThrottleAttempt(db: Database, ip: string, params: IpThrottleParams): Promise<IpThrottleDecision> {
  const [row] = await db
    .insert(authIpThrottle)
    .values({ ip })
    .returning({
      priorAttemptsInWindow: sql<number>`(
        select count(*) from ${authIpThrottle}
        where ${authIpThrottle.ip} = ${ip}
          and ${authIpThrottle.createdAt} > now() - make_interval(secs => ${params.windowSeconds})
      )`,
    });
  await cleanupOldIpThrottleRows(db);
  const attemptsInWindow = Number(row?.priorAttemptsInWindow ?? 0) + 1; // +1 for this call's own row
  return { limited: attemptsInWindow > params.max };
}

/** Opportunistic pruning — same reasoning as email-throttle.ts's `cleanupOldThrottleRows`. */
async function cleanupOldIpThrottleRows(db: Database): Promise<void> {
  if (Math.random() >= CLEANUP_PROBABILITY) return;
  await db.delete(authIpThrottle).where(sql`${authIpThrottle.createdAt} < now() - make_interval(secs => ${RETENTION_SECONDS})`);
}
