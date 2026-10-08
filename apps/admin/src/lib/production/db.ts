import "server-only";
import { eq } from "drizzle-orm";
import { productionBatches } from "@ammari/db/schema";
import type { Tx } from "@/lib/db";

export type { Tx, Database } from "@/lib/db";

/** `SELECT ... FOR UPDATE` on one production_batches row — MUST be the first statement inside
 * any transaction that reads or changes a batch's status (update draft, delete draft, post).
 * Without it, two concurrent "post this batch" calls could both read status = 'draft' and both
 * post — this lock serializes them so the second one re-reads the first's committed 'posted'
 * status and fails cleanly instead. Only usable inside `tx` (a real transaction) — `.for("update")`
 * outside one is a no-op in Postgres and would silently defeat the whole point. */
export async function lockProductionBatchForUpdate(
  tx: Tx,
  batchId: string,
): Promise<typeof productionBatches.$inferSelect | null> {
  const [batch] = await tx.select().from(productionBatches).where(eq(productionBatches.id, batchId)).for("update");
  return batch ?? null;
}
