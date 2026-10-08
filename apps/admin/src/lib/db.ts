import "server-only";
import { db as defaultDb } from "@ammari/db";
import { auditLog } from "@ammari/db/schema";

// Shared across every feature (products, production, stock, ...): every query function accepts
// either the real top-level client or a transaction object (e.g. one function calling another
// from inside its own `db.transaction`) — same pattern packages/db/test/helpers.ts's `TestTx`
// uses.
export type Tx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];
export type Database = typeof defaultDb | Tx;
export { defaultDb };

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
