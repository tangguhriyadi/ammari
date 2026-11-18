import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { thankYouCards, vouchers } from "@ammari/db/schema";
import { writeAuditLog, type Tx } from "./db";

/** Voids an order's active thank-you card, if it has one — called from
 * `transitionOrderStatus` (orders/lifecycle.ts) in the SAME transaction as a cancelled/
 * returned transition, so a card is never left `active` for an order that no longer is.
 * Already-`claimed` cards are never touched here; the voucher they issued is handled by
 * `voidUnusedVoucherForEndedOrder` below. No-op (returns `null`) when there's no active card to
 * void, so callers don't need their own existence check first. */
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

/** SPEC §8: a voucher is voided when its source order is cancelled or returned before the voucher
 * is used. Called from `transitionOrderStatus` in the SAME transaction as a cancelled/returned
 * transition, after the order's row lock (the claim takes that lock first too, so a claim racing
 * this either commits before it, and its voucher is voided here, or sees the order ended and is
 * refused). "Unused" = not attached to any order: stored `active` or `expired` (a voucher whose
 * order was cancelled is back to one of these, restoreVoucherForCancelledOrder). A `used` voucher
 * is left alone. The card itself stays `claimed`. Locked, then one conditional UPDATE with the same
 * guards, so a checkout redeeming the voucher at the same moment either wins (the voucher stays
 * used) or finds it void. One audit row per voided voucher. */
export async function voidUnusedVoucherForEndedOrder(
  tx: Tx,
  orderId: string,
  orderStatus: "cancelled" | "returned",
  actorStaffUserId: string | null,
): Promise<string[]> {
  const unused = and(inArray(vouchers.status, ["active", "expired"]), isNull(vouchers.usedOrderId));
  const fromThisOrder = inArray(vouchers.cardId, tx.select({ id: thankYouCards.id }).from(thankYouCards).where(eq(thankYouCards.orderId, orderId)));
  const before = await tx.select().from(vouchers).where(and(fromThisOrder, unused)).for("update");
  if (before.length === 0) return [];

  const voided = await tx
    .update(vouchers)
    .set({ status: "void" })
    .where(and(inArray(vouchers.id, before.map((voucher) => voucher.id)), unused))
    .returning();
  for (const voucher of voided) {
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "void_source_order_ended",
      entityType: "voucher",
      entityId: voucher.id,
      before: before.find((row) => row.id === voucher.id),
      after: { voucher, sourceOrderId: orderId, sourceOrderStatus: orderStatus },
    });
  }
  return voided.map((voucher) => voucher.id);
}
