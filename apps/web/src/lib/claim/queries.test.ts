import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback } from "@ammari/db/test-utils";
import { insertCustomer, insertOrder, insertThankYouCard } from "@ammari/db/test-fixtures";
import { auditLog, customers, orders, thankYouCards, vouchers } from "@ammari/db/schema";
import { lookupClaimCard, claimVoucher } from "./queries";

function freshTokenHash(): string {
  return `hash-${randomUUID()}`;
}

const FUTURE_DEADLINE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PAST_DEADLINE = new Date(Date.now() - 24 * 60 * 60 * 1000);

describe("lookupClaimCard", () => {
  test("not_found for a token hash with no matching card", async () => {
    await withRollback(async (tx) => {
      const result = await lookupClaimCard(freshTokenHash(), tx);
      expect(result).toEqual({ status: "rejected", reason: "not_found", claimedByCustomerId: null });
    });
  });

  test("void card is rejected as void", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      const tokenHash = freshTokenHash();
      await insertThankYouCard(tx, order.id, { tokenHash, status: "void", claimDeadline: FUTURE_DEADLINE });

      const result = await lookupClaimCard(tokenHash, tx);
      expect(result).toEqual({ status: "rejected", reason: "void", claimedByCustomerId: null });
    });
  });

  test("already-claimed card is rejected as claimed, naming who claimed it", async () => {
    await withRollback(async (tx) => {
      const claimer = await insertCustomer(tx);
      const order = await insertOrder(tx);
      const tokenHash = freshTokenHash();
      await insertThankYouCard(tx, order.id, {
        tokenHash,
        status: "claimed",
        claimDeadline: FUTURE_DEADLINE,
        claimedByCustomerId: claimer.id,
        claimedAt: new Date(),
      });

      const result = await lookupClaimCard(tokenHash, tx);
      expect(result).toEqual({ status: "rejected", reason: "claimed", claimedByCustomerId: claimer.id });
    });
  });

  test("expired (deadline passed, still active) is rejected as expired", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      const tokenHash = freshTokenHash();
      await insertThankYouCard(tx, order.id, { tokenHash, status: "active", claimDeadline: PAST_DEADLINE });

      const result = await lookupClaimCard(tokenHash, tx);
      expect(result).toEqual({ status: "rejected", reason: "expired", claimedByCustomerId: null });
    });
  });

  test("source order cancelled/returned is rejected as order_cancelled even though the card itself is active", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx, { status: "cancelled" });
      const tokenHash = freshTokenHash();
      await insertThankYouCard(tx, order.id, { tokenHash, status: "active", claimDeadline: FUTURE_DEADLINE });

      const result = await lookupClaimCard(tokenHash, tx);
      expect(result).toEqual({ status: "rejected", reason: "order_cancelled", claimedByCustomerId: null });
    });
  });

  test("an active card with a live order and a future deadline is claimable", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      const tokenHash = freshTokenHash();
      await insertThankYouCard(tx, order.id, { tokenHash, status: "active", claimDeadline: FUTURE_DEADLINE });

      const result = await lookupClaimCard(tokenHash, tx);
      expect(result).toEqual({ status: "claimable" });
    });
  });
});

describe("claimVoucher", () => {
  test("rejects every reason lookupClaimCard would, and records a claim_rejected audit entry naming it", async () => {
    await withRollback(async (tx) => {
      const customer = await insertCustomer(tx);

      const voidOrder = await insertOrder(tx);
      const voidTokenHash = freshTokenHash();
      const voidCard = await insertThankYouCard(tx, voidOrder.id, {
        tokenHash: voidTokenHash,
        status: "void",
        claimDeadline: FUTURE_DEADLINE,
      });
      const voidOutcome = await claimVoucher(voidTokenHash, customer, tx);
      expect(voidOutcome).toEqual({ ok: false, reason: "void", claimedByCustomerId: null });

      const expiredOrder = await insertOrder(tx);
      const expiredTokenHash = freshTokenHash();
      const expiredCard = await insertThankYouCard(tx, expiredOrder.id, {
        tokenHash: expiredTokenHash,
        status: "active",
        claimDeadline: PAST_DEADLINE,
      });
      const expiredOutcome = await claimVoucher(expiredTokenHash, customer, tx);
      expect(expiredOutcome).toEqual({ ok: false, reason: "expired", claimedByCustomerId: null });

      const cancelledOrder = await insertOrder(tx, { status: "cancelled" });
      const cancelledTokenHash = freshTokenHash();
      const cancelledCard = await insertThankYouCard(tx, cancelledOrder.id, {
        tokenHash: cancelledTokenHash,
        status: "active",
        claimDeadline: FUTURE_DEADLINE,
      });
      const cancelledOutcome = await claimVoucher(cancelledTokenHash, customer, tx);
      expect(cancelledOutcome).toEqual({ ok: false, reason: "order_cancelled", claimedByCustomerId: null });

      const otherCustomer = await insertCustomer(tx);
      const claimedOrder = await insertOrder(tx);
      const claimedTokenHash = freshTokenHash();
      const claimedCard = await insertThankYouCard(tx, claimedOrder.id, {
        tokenHash: claimedTokenHash,
        status: "claimed",
        claimDeadline: FUTURE_DEADLINE,
        claimedByCustomerId: otherCustomer.id,
        claimedAt: new Date(),
      });
      const claimedOutcome = await claimVoucher(claimedTokenHash, customer, tx);
      expect(claimedOutcome).toEqual({ ok: false, reason: "claimed", claimedByCustomerId: otherCustomer.id });

      for (const card of [voidCard, expiredCard, cancelledCard, claimedCard]) {
        const [entry] = await tx.select().from(auditLog).where(eq(auditLog.entityId, card.id));
        expect(entry?.action).toBe("claim_rejected");
        expect(entry?.actorStaffUserId).toBeNull();
        expect((entry?.after as { reason?: string } | null)?.reason).toBe(
          card === voidCard
            ? "void"
            : card === expiredCard
              ? "expired"
              : card === cancelledCard
                ? "order_cancelled"
                : "claimed",
        );
        // The raw claim token is never persisted anywhere — only the card's id/hash.
        expect(JSON.stringify(entry)).not.toContain(voidTokenHash.replace("hash-", ""));
      }
    });
  });

  test("rejects with consent_required when the claiming customer has no pdp_consent_at, and still never claims the card", async () => {
    await withRollback(async (tx) => {
      const unconsentedCustomer = await insertCustomer(tx, { pdpConsentAt: null });
      const order = await insertOrder(tx);
      const tokenHash = freshTokenHash();
      const card = await insertThankYouCard(tx, order.id, { tokenHash, status: "active", claimDeadline: FUTURE_DEADLINE });

      const outcome = await claimVoucher(tokenHash, unconsentedCustomer, tx);
      expect(outcome).toEqual({ ok: false, reason: "consent_required", claimedByCustomerId: null });

      const [unchanged] = await tx.select().from(thankYouCards).where(eq(thankYouCards.id, card.id));
      expect(unchanged?.status).toBe("active");

      const [entry] = await tx.select().from(auditLog).where(eq(auditLog.entityId, card.id));
      expect(entry?.action).toBe("claim_rejected");
      expect((entry?.after as { reason?: string } | null)?.reason).toBe("consent_required");
    });
  });

  test("on success: claims the card, issues a voucher, links the order only when customerId was null, and audits 'claim'", async () => {
    await withRollback(async (tx) => {
      const customer = await insertCustomer(tx);
      const order = await insertOrder(tx); // customerId defaults to null
      const tokenHash = freshTokenHash();
      const card = await insertThankYouCard(tx, order.id, { tokenHash, status: "active", claimDeadline: FUTURE_DEADLINE });

      const outcome = await claimVoucher(tokenHash, customer, tx);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("unreachable");
      expect(outcome.voucher.amount).toBe(20000);
      expect(outcome.voucher.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const [updatedCard] = await tx.select().from(thankYouCards).where(eq(thankYouCards.id, card.id));
      expect(updatedCard?.status).toBe("claimed");
      expect(updatedCard?.claimedByCustomerId).toBe(customer.id);
      expect(updatedCard?.claimedAt).not.toBeNull();

      const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.cardId, card.id));
      expect(voucher?.customerId).toBe(customer.id);
      expect(voucher?.amount).toBe(20000);

      const [updatedOrder] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(updatedOrder?.customerId).toBe(customer.id); // was null -> now linked

      const [entry] = await tx.select().from(auditLog).where(eq(auditLog.entityId, card.id));
      expect(entry?.action).toBe("claim");
      expect(entry?.actorStaffUserId).toBeNull();
    });
  });

  test("never overwrites orders.customerId when it was already set to a different customer", async () => {
    await withRollback(async (tx) => {
      const originalCustomer = await insertCustomer(tx);
      const claimingCustomer = await insertCustomer(tx);
      const order = await insertOrder(tx, { customerId: originalCustomer.id });
      const tokenHash = freshTokenHash();
      await insertThankYouCard(tx, order.id, { tokenHash, status: "active", claimDeadline: FUTURE_DEADLINE });

      const outcome = await claimVoucher(tokenHash, claimingCustomer, tx);
      expect(outcome.ok).toBe(true);

      const [updatedOrder] = await tx.select().from(orders).where(eq(orders.id, order.id));
      // Order stays linked to whoever it was already linked to — the voucher itself still goes
      // to the customer who actually claimed it (checked above), independent of this.
      expect(updatedOrder?.customerId).toBe(originalCustomer.id);
    });
  });

  // Needs two REAL, independently-committing transactions racing each other — withRollback's
  // single shared transaction can't exercise this, so this test runs directly against testDb
  // and cleans up its own rows afterward (same pattern as apps/admin's stock-adjustment
  // concurrency test, lib/stock/queries.test.ts).
  test("two concurrent claims for the same card: exactly one voucher, one 'claim' audit entry", async () => {
    const customerA = await insertCustomer(testDb);
    const customerB = await insertCustomer(testDb);
    const order = await insertOrder(testDb);
    const tokenHash = freshTokenHash();
    const card = await insertThankYouCard(testDb, order.id, { tokenHash, status: "active", claimDeadline: FUTURE_DEADLINE });

    try {
      const outcomes = await Promise.all([
        claimVoucher(tokenHash, customerA, testDb),
        claimVoucher(tokenHash, customerB, testDb),
      ]);

      const succeeded = outcomes.filter((o) => o.ok);
      const rejected = outcomes.filter((o) => !o.ok);
      expect(succeeded).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({ reason: "claimed" });

      const vouchersForCard = await testDb.select().from(vouchers).where(eq(vouchers.cardId, card.id));
      expect(vouchersForCard).toHaveLength(1);

      const auditEntries = await testDb.select().from(auditLog).where(eq(auditLog.entityId, card.id));
      const claimEntries = auditEntries.filter((e) => e.action === "claim");
      const rejectedEntries = auditEntries.filter((e) => e.action === "claim_rejected");
      expect(claimEntries).toHaveLength(1);
      expect(rejectedEntries).toHaveLength(1);

      const [finalCard] = await testDb.select().from(thankYouCards).where(eq(thankYouCards.id, card.id));
      expect(finalCard?.status).toBe("claimed");
    } finally {
      await testDb.delete(auditLog).where(eq(auditLog.entityId, card.id));
      await testDb.delete(vouchers).where(eq(vouchers.cardId, card.id));
      await testDb.delete(thankYouCards).where(eq(thankYouCards.id, card.id));
      await testDb.delete(orders).where(eq(orders.id, order.id));
      await testDb.delete(customers).where(eq(customers.id, customerA.id));
      await testDb.delete(customers).where(eq(customers.id, customerB.id));
    }
  });
});
