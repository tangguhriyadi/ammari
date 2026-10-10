import "server-only";
import { eq } from "drizzle-orm";
import { orders, thankYouCards, vouchers } from "@ammari/db/schema";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { voucherExpiresAt } from "./dates";

/** Reasons a card fails validation BEFORE any identity/consent question even comes up — pure
 * card/order state, independent of who's asking. Mirrors docs/SPEC.md §4.3's claim checklist
 * and apps/admin/src/lib/packing/token.ts's reminder that an `active` card status alone doesn't
 * prove the source order is still live. */
export type CardRejectionReason = "not_found" | "void" | "claimed" | "expired" | "order_cancelled";

/** The full set of reasons `claimVoucher` can refuse — adds `consent_required`, which only
 * applies once we already know WHO is asking (decided plan, option (c): the claim action
 * independently re-checks `pdp_consent_at` server-side, not just via a page-level redirect). */
export type ClaimRejectionReason = CardRejectionReason | "consent_required";

interface CardState {
  status: string;
  claimedByCustomerId: string | null;
  claimDeadline: Date;
}
interface OrderState {
  status: string;
}

/** Pure classification shared by the read-only preview (`lookupClaimCard`) and the real atomic
 * claim (`claimVoucher`) — kept as one function so the two paths can never disagree about what
 * counts as claimable. Order of checks matters: card-level states (void/claimed) are checked
 * before ever looking at the order, and the order's cancelled/returned check runs before the
 * deadline check — matching docs/SPEC.md §4.3's own checklist order. */
function classifyCard(card: CardState, order: OrderState, now: Date): CardRejectionReason | null {
  if (card.status === "void") return "void";
  if (card.status === "claimed") return "claimed";
  if (order.status === "cancelled" || order.status === "returned") return "order_cancelled";
  if (card.claimDeadline.getTime() < now.getTime()) return "expired";
  return null;
}

export type ClaimPreview =
  | { status: "claimable" }
  | { status: "rejected"; reason: CardRejectionReason; claimedByCustomerId: string | null };

/** Read-only lookup for the `/claim/[token]` page's own display decision (show the claim button,
 * an "already claimed by you" message, or a generic rejection) — NEVER the security boundary
 * for the write itself. `claimVoucher` below independently re-validates everything under a row
 * lock at submission time; this function can be (and is meant to be) called speculatively,
 * including before the visitor has even signed in. */
export async function lookupClaimCard(tokenHash: string, db: Database = defaultDb): Promise<ClaimPreview> {
  const [row] = await db
    .select({
      cardStatus: thankYouCards.status,
      claimedByCustomerId: thankYouCards.claimedByCustomerId,
      claimDeadline: thankYouCards.claimDeadline,
      orderStatus: orders.status,
    })
    .from(thankYouCards)
    .innerJoin(orders, eq(orders.id, thankYouCards.orderId))
    .where(eq(thankYouCards.tokenHash, tokenHash))
    .limit(1);
  if (!row) return { status: "rejected", reason: "not_found", claimedByCustomerId: null };

  const reason = classifyCard(
    { status: row.cardStatus, claimedByCustomerId: row.claimedByCustomerId, claimDeadline: row.claimDeadline },
    { status: row.orderStatus },
    new Date(),
  );
  if (reason) return { status: "rejected", reason, claimedByCustomerId: row.claimedByCustomerId };
  return { status: "claimable" };
}

export type ClaimOutcome =
  | { ok: true; voucher: { amount: number; expiresAt: Date } }
  | { ok: false; reason: ClaimRejectionReason; claimedByCustomerId: string | null };

/** The atomic claim transaction (CLAUDE.md: concurrent writes must be a transaction + row
 * lock/conditional update, never check-then-write). Locks the card row FIRST, then its order —
 * a second concurrent call for the SAME token blocks on the card lock until the first commits,
 * then re-reads the now-`claimed` row itself rather than trusting any pre-fetched state, so
 * exactly one of two concurrent claims for the same card ever succeeds. Every outcome past this
 * point (reject or succeed) writes exactly one `audit_log` row keyed by `thank_you_cards.id` —
 * never the raw token (CLAUDE.md / docs/plans/voucher-claim.md). */
export async function claimVoucher(
  tokenHash: string,
  customer: { id: string; pdpConsentAt: Date | null },
  db: Database = defaultDb,
): Promise<ClaimOutcome> {
  return db.transaction(async (tx) => {
    const [card] = await tx.select().from(thankYouCards).where(eq(thankYouCards.tokenHash, tokenHash)).for("update").limit(1);
    if (!card) return { ok: false, reason: "not_found", claimedByCustomerId: null };

    // ON DELETE RESTRICT on thank_you_cards.order_id guarantees this row always exists.
    const [order] = await tx.select().from(orders).where(eq(orders.id, card.orderId)).for("update").limit(1);
    if (!order) throw new Error(`order ${card.orderId} missing for thank_you_card ${card.id}`);

    const cardReason = classifyCard(card, order, new Date());
    if (cardReason) {
      await writeAuditLog(tx, {
        action: "claim_rejected",
        entityType: "thank_you_card",
        entityId: card.id,
        after: { reason: cardReason, attemptedByCustomerId: customer.id },
      });
      return { ok: false, reason: cardReason, claimedByCustomerId: card.claimedByCustomerId };
    }

    if (customer.pdpConsentAt === null) {
      await writeAuditLog(tx, {
        action: "claim_rejected",
        entityType: "thank_you_card",
        entityId: card.id,
        after: { reason: "consent_required", attemptedByCustomerId: customer.id },
      });
      return { ok: false, reason: "consent_required", claimedByCustomerId: null };
    }

    const claimedAt = new Date();
    const expiresAt = voucherExpiresAt(claimedAt);

    const [claimedCard] = await tx
      .update(thankYouCards)
      .set({ status: "claimed", claimedByCustomerId: customer.id, claimedAt })
      .where(eq(thankYouCards.id, card.id))
      .returning();
    if (!claimedCard) throw new Error(`failed to update thank_you_card ${card.id} to claimed`);

    const [voucher] = await tx
      .insert(vouchers)
      .values({ cardId: card.id, customerId: customer.id, expiresAt })
      .returning();
    if (!voucher) throw new Error(`failed to insert voucher for card ${card.id}`);

    // "orders.customerId only-if-null" — a card claim never overwrites an order already linked
    // to a (possibly different) customer, e.g. one entered manually by staff beforehand.
    if (order.customerId === null) {
      await tx.update(orders).set({ customerId: customer.id }).where(eq(orders.id, order.id));
    }

    await writeAuditLog(tx, {
      action: "claim",
      entityType: "thank_you_card",
      entityId: card.id,
      before: card,
      after: claimedCard,
    });

    return { ok: true, voucher: { amount: voucher.amount, expiresAt: voucher.expiresAt } };
  });
}
