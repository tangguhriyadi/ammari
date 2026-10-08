import "server-only";
import { sql } from "drizzle-orm";
import { productionBatches } from "@ammari/db/schema";
import type { Tx } from "@/lib/db";
import { jakartaYearMonth } from "./jakarta-month";

/** Generates the next "PRD-YYYYMM-NNN" batch number for whichever month `now` falls in
 * (Asia/Jakarta) — collision-safe under concurrency via a per-month Postgres advisory lock
 * (`pg_advisory_xact_lock`, released automatically when `tx` commits or rolls back), NOT a
 * check-then-write race: no other transaction can compute a candidate for the SAME month while
 * this one holds the lock, so there is nothing to retry. `unique(batch_no)` stays as a backstop
 * (CLAUDE.md's "unique constraint + transaction" rule), but should never actually fire.
 *
 * Scoped to this exact month string's hash, not the month itself — a different month never
 * contends for this lock, and a hash collision between two DIFFERENT months only costs harmless
 * extra serialization (the `like` filter below is keyed on the real string, not the hash), never
 * an incorrect or shared sequence.
 *
 * MUST be called inside `tx` (a real transaction) — `pg_advisory_xact_lock` outside one would
 * never release. The sequence itself is `split_part(batch_no, '-', 3)::int`, NOT
 * `substring(batch_no from 10)` (which mis-slices "PRD-202610-001" into "0-001" and fails the
 * int cast) — split on '-' and take the third field instead. */
export async function generateBatchNumber(tx: Tx, now: Date = new Date()): Promise<string> {
  const yearMonth = jakartaYearMonth(now);
  const prefix = `PRD-${yearMonth}-`;

  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${prefix}))`);

  const [row] = await tx
    .select({ maxSeq: sql<number | null>`max(split_part(${productionBatches.batchNo}, '-', 3)::int)` })
    .from(productionBatches)
    .where(sql`${productionBatches.batchNo} like ${`${prefix}%`}`);

  const next = (row?.maxSeq ?? 0) + 1;
  return `${prefix}${String(next).padStart(3, "0")}`;
}
