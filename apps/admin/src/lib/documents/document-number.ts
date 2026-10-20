import "server-only";
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Tx } from "@/lib/db";
import { jakartaYearMonth } from "@ammari/commerce/jakarta-month";

/** Generates the next "<PREFIX>-YYYYMM-NNN" document number for whichever month `now` falls in
 * (Asia/Jakarta), reading the current maximum from `column` (docs/plans/suppliers-goods-receipt.md
 * §4.1 — the generalization of the original production batch-number generator, which is now a thin
 * caller of this). Collision-safe under concurrency via a per-month, per-prefix Postgres advisory
 * lock (`pg_advisory_xact_lock`, released automatically when `tx` commits or rolls back), NOT a
 * check-then-write race: no other transaction can compute a candidate for the SAME prefix and
 * month while this one holds the lock, so there is nothing to retry. The column's own unique
 * constraint stays as a backstop (CLAUDE.md's "unique constraint + transaction" rule), but should
 * never actually fire.
 *
 * Scoped to this exact "<PREFIX>-YYYYMM-" string's hash — a different month or prefix never
 * contends for this lock, and a hash collision between two DIFFERENT strings only costs harmless
 * extra serialization (the `like` filter below is keyed on the real string, not the hash), never
 * an incorrect or shared sequence.
 *
 * MUST be called inside `tx` (a real transaction) — `pg_advisory_xact_lock` outside one would
 * never release. The sequence itself is `split_part(no, '-', 3)::int`, NOT a fixed-offset
 * substring (which mis-slices a longer prefix and fails the int cast) — split on '-' and take the
 * third field instead. `prefix` must therefore never itself contain a '-'. */
export async function nextDocumentNumber(tx: Tx, prefix: string, column: AnyPgColumn, now: Date = new Date()): Promise<string> {
  if (prefix.includes("-")) throw new Error(`document prefix must not contain "-": ${prefix}`);
  const monthPrefix = `${prefix}-${jakartaYearMonth(now)}-`;

  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${monthPrefix}))`);

  const [row] = await tx
    .select({ maxSeq: sql<number | null>`max(split_part(${column}, '-', 3)::int)` })
    .from(column.table)
    .where(sql`${column} like ${`${monthPrefix}%`}`);

  const next = (row?.maxSeq ?? 0) + 1;
  return `${monthPrefix}${String(next).padStart(3, "0")}`;
}
