import "server-only";
import { sql } from "drizzle-orm";
import type { Database } from "../db";
import { errorLogFields } from "../errors";

// One cron job at a time (docs/plans/cart-checkout.md §6.3, §11): a run holds a transaction-scoped
// advisory lock in a transaction of its own for as long as it runs, so a second run (a slow run
// overlapping the next cron tick, two web slots during a prod flip, a manual call, or the other
// cron job) is skipped instead of racing it. All cron jobs share ONE lock: they never overlap, so
// cron work never holds more than two of the pool's five connections (this idle lock transaction
// and the job's own queries). The lock transaction does nothing else (no row locks, no writes),
// and the job runs on other connections: it calls the gateway between its own short transactions,
// never inside one. If the process dies, the connection closes and Postgres drops the lock.

/** The advisory lock's two keys. Distinct from placeOrder's namespace (checkout/place-order.ts). */
const CRON_LOCK_NAMESPACE = 72_810_312;
const CRON_LOCK_KEY = 1;

export const CRON_JOBS = ["paymentSweep", "retention", "orderEmails", "shipmentPoll"] as const;
export type CronJob = (typeof CRON_JOBS)[number];

export type ExclusiveRun<T> = { ran: true; value: T } | { ran: false };

/** Runs `run` only if no cron job holds the lock; otherwise returns `{ ran: false }` at once
 * (never waits). A failure of the lock transaction itself after `run` finished (its connection
 * dropped) is logged and the finished run's value still returned: the work is done and committed
 * on its own connections. */
export async function withExclusiveRun<T>(db: Database, job: CronJob, run: () => Promise<T>): Promise<ExclusiveRun<T>> {
  let finished: { value: T } | null = null;
  try {
    return await db.transaction(async (lockTx) => {
      // A server-side idle-in-transaction timeout must never end the lock mid-run.
      await lockTx.execute(sql`set local idle_in_transaction_session_timeout = 0`);
      const [row] = await lockTx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(${CRON_LOCK_NAMESPACE}::int, ${CRON_LOCK_KEY}::int) as locked`);
      if (!row?.locked) return { ran: false } as const;
      const value = await run();
      finished = { value };
      return { ran: true, value } as const;
    });
  } catch (error) {
    if (finished === null) throw error;
    console.warn("[cron] lock transaction failed after the run finished; its result stands", { job, ...errorLogFields(error) });
    return { ran: true, value: (finished as { value: T }).value };
  }
}
