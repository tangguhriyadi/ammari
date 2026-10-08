import "server-only";
import { eq } from "drizzle-orm";
import { products } from "@ammari/db/schema";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";

// Re-exported for this feature's existing call sites (`from "./db"`) — the real definitions are
// shared across every feature now (@/lib/db), not products-specific despite this file's name.
export { defaultDb, writeAuditLog, type Database, type Tx };

/** `SELECT ... FOR UPDATE` on one product row — MUST be the first statement inside any
 * transaction that can affect the required-photo invariant or the thumbnail (upload, delete,
 * reorder, set-thumbnail, product activation, addVariants, setVariantActive). Without it, two
 * concurrent requests touching the same product (e.g. two "delete the last-but-one photo of
 * this color" calls) both read the same pre-change counts and could both decide their delete is
 * safe — this lock serializes them so the second one re-reads post-first-commit state. Only
 * usable inside `tx` (a real transaction) — `.for("update")` outside one is a no-op in Postgres
 * and would silently defeat the whole point. */
export async function lockProductForUpdate(tx: Tx, productId: string): Promise<typeof products.$inferSelect | null> {
  const [product] = await tx.select().from(products).where(eq(products.id, productId)).for("update");
  return product ?? null;
}
