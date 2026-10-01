import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { thankYouCards } from "../src/schema";
import { withRollback } from "./helpers";
import { insertOrder, insertThankYouCard } from "./fixtures";

describe("thank_you_cards", () => {
  test("a second active card for the same order fails", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      await insertThankYouCard(tx, order.id);

      await expect(insertThankYouCard(tx, order.id)).rejects.toThrow();
    });
  });

  test("voiding the old card then inserting a new active one succeeds", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      const firstCard = await insertThankYouCard(tx, order.id);

      await tx.update(thankYouCards).set({ status: "void" }).where(eq(thankYouCards.id, firstCard.id));

      const secondCard = await insertThankYouCard(tx, order.id);
      expect(secondCard.status).toBe("active");

      const cardsForOrder = await tx.select().from(thankYouCards).where(eq(thankYouCards.orderId, order.id));
      expect(cardsForOrder).toHaveLength(2);
    });
  });

  test("claimed consistency CHECK: status='claimed' requires claimed_by_customer_id and claimed_at", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);

      // status='claimed' but claimed_by_customer_id/claimed_at left null — must fail.
      await expect(
        insertThankYouCard(tx, order.id, { status: "claimed" }),
      ).rejects.toThrow();
    });
  });

  test("claimed consistency CHECK: claimed_by_customer_id set without status='claimed' fails", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      // A non-existent customer id is fine here: the CHECK fires before the FK would even be
      // evaluated is not guaranteed, so use a syntactically valid uuid; either constraint
      // failing proves the row is rejected.
      await expect(
        insertThankYouCard(tx, order.id, { claimedByCustomerId: randomUUID() }),
      ).rejects.toThrow();
    });
  });
});
