import "server-only";
import { eq } from "drizzle-orm";
import { db as defaultDb } from "@ammari/db";
import { auditLog, products } from "@ammari/db/schema";

// Every function in this feature accepts either the real top-level client or a transaction
// object (e.g. one function calling another from inside its own `db.transaction`) — same
// pattern packages/db/test/helpers.ts's `TestTx` uses.
export type Tx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];
export type Database = typeof defaultDb | Tx;
export { defaultDb };

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

export async function writeAuditLog(
  tx: Database,
  params: {
    actorStaffUserId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorStaffUserId: params.actorStaffUserId,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    before: params.before ?? null,
    after: params.after ?? null,
  });
}
