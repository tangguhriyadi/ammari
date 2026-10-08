import "server-only";
import { eq } from "drizzle-orm";
import { productVariants } from "@ammari/db/schema";
import type { Tx } from "@/lib/db";

export type { Tx, Database } from "@/lib/db";

/** `SELECT ... FOR UPDATE` on one product_variants row — MUST be the first statement inside any
 * transaction that adjusts a SKU's stock (manual adjustment, stock count line). Without it, two
 * concurrent adjustments on the SAME sku could both read the same pre-change balance and both
 * decide a negative result is still non-negative — this lock serializes them so the second one
 * recomputes the balance AFTER the first has committed. Only usable inside `tx` (a real
 * transaction) — `.for("update")` outside one is a no-op in Postgres and would silently defeat
 * the whole point (same idiom as lockProductForUpdate/lockProductionBatchForUpdate). */
export async function lockVariantForUpdate(tx: Tx, sku: string): Promise<typeof productVariants.$inferSelect | null> {
  const [variant] = await tx.select().from(productVariants).where(eq(productVariants.sku, sku)).for("update");
  return variant ?? null;
}
