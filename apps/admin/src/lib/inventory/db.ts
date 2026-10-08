import "server-only";
import { eq } from "drizzle-orm";
import { accessories, fabrics } from "@ammari/db/schema";
import type { Tx } from "@/lib/db";

export type { Tx, Database } from "@/lib/db";

/** `SELECT ... FOR UPDATE` on one accessories row — MUST be the first statement inside any
 * transaction that records a purchase, a void, or an adjustment against it. Same idiom as
 * lockVariantForUpdate/lockProductionBatchForUpdate: serializes concurrent writers on the SAME
 * item so each one recomputes the balance (and therefore the average cost) AFTER any earlier
 * one in the same race has committed, instead of two readers both working from the same stale
 * balance. Only usable inside `tx` (a real transaction) — `.for("update")` outside one is a
 * no-op in Postgres. */
export async function lockAccessoryForUpdate(tx: Tx, id: string): Promise<typeof accessories.$inferSelect | null> {
  const [accessory] = await tx.select().from(accessories).where(eq(accessories.id, id)).for("update");
  return accessory ?? null;
}

/** Same contract as lockAccessoryForUpdate, for a fabrics row — fabrics previously had no
 * mutable stock concept at all (only a reference price), so this lock is new as of the
 * raw-material-inventory feature. */
export async function lockFabricForUpdate(tx: Tx, id: string): Promise<typeof fabrics.$inferSelect | null> {
  const [fabric] = await tx.select().from(fabrics).where(eq(fabrics.id, id)).for("update");
  return fabric ?? null;
}
