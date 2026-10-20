import "server-only";
import { and, eq } from "drizzle-orm";
import { thankYouCards } from "@ammari/db/schema";
import { writeAuditLog, type Tx } from "./db";

/** Voids an order's active thank-you card, if it has one — called from
 * `transitionOrderStatus` (orders/lifecycle.ts) in the SAME transaction as a cancelled/
 * returned transition, so a card is never left `active` for an order that no longer is.
 * Already-`claimed` cards (and the voucher they issued) are never touched here — the owner
 * decides that policy separately (docs/plans/packing-cards.md). No-op (returns `null`) when
 * there's no active card to void, so callers don't need their own existence check first. */
export async function voidActiveCardForOrder(
  tx: Tx,
  orderId: string,
  actorStaffUserId: string | null,
): Promise<{ id: string } | null> {
  const [voided] = await tx
    .update(thankYouCards)
    .set({ status: "void" })
    .where(and(eq(thankYouCards.orderId, orderId), eq(thankYouCards.status, "active")))
    .returning();
  if (!voided) return null;

  await writeAuditLog(tx, {
    actorStaffUserId,
    action: "void",
    entityType: "thank_you_card",
    entityId: voided.id,
    after: voided,
  });
  return { id: voided.id };
}
