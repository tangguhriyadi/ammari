import "server-only";
import { db as defaultDb } from "@ammari/db";
import { auditLog } from "@ammari/db/schema";

// Mirrors apps/admin's own lib/db.ts (same Database/Tx union, same writeAuditLog shape) — kept
// local rather than shared, same reasoning as this app's own lib/errors.ts.
export type Tx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];
export type Database = typeof defaultDb | Tx;
export { defaultDb };

/** `audit_log.actor_staff_user_id` is staff-only (FK to `staff_users`) — there is no customer
 * actor column, so every claim-flow entry is written with that column `null` and the acting
 * customer's id folded into `before`/`after` instead (see callers in lib/claim/queries.ts). The
 * raw claim token is NEVER passed to `before`/`after` by any caller — only `thank_you_cards.id`
 * (as `entityId`) and the card/voucher ROWS themselves, matching the packing side's existing
 * convention (apps/admin/src/lib/packing/queries.ts). */
export async function writeAuditLog(
  tx: Database,
  params: {
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorStaffUserId: null,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    before: params.before ?? null,
    after: params.after ?? null,
  });
}
