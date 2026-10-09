import "server-only";
import { sql } from "drizzle-orm";
import { orders } from "@ammari/db/schema";
import type { Tx } from "@/lib/db";
import { jakartaYearMonth } from "@/lib/production/jakarta-month";

/** Generates the next "ORD-YYYYMM-NNNN" order number for whichever month `now` falls in
 * (Asia/Jakarta) — same collision-safe idiom as production's generateBatchNumber: a per-month
 * Postgres advisory lock (`pg_advisory_xact_lock`, released automatically when `tx` commits or
 * rolls back), NOT a check-then-write race. `unique(order_no)` stays as a backstop (CLAUDE.md's
 * "unique constraint + transaction" rule), but should never actually fire.
 *
 * Keyed on its own prefix ("ORD-...", not "PRD-...") so this never contends with
 * generateBatchNumber's advisory lock for the same month.
 *
 * MUST be called inside `tx` (a real transaction) — `pg_advisory_xact_lock` outside one would
 * never release. The sequence is `split_part(order_no, '-', 3)::int`, matching
 * generateBatchNumber's own split-on-'-' approach (NOT a fixed-offset substring, which
 * mis-slices once the year rolls and would silently fail the int cast). 4-digit, zero-padded
 * sequence (vs. production's 3-digit) — orders are expected to run higher per month. */
export async function generateOrderNumber(tx: Tx, now: Date = new Date()): Promise<string> {
  const yearMonth = jakartaYearMonth(now);
  const prefix = `ORD-${yearMonth}-`;

  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${prefix}))`);

  const [row] = await tx
    .select({ maxSeq: sql<number | null>`max(split_part(${orders.orderNo}, '-', 3)::int)` })
    .from(orders)
    .where(sql`${orders.orderNo} like ${`${prefix}%`}`);

  const next = (row?.maxSeq ?? 0) + 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}
