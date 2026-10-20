import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { insertOrder, insertThankYouCard } from "@ammari/db/test-fixtures";
import { thankYouCards } from "@ammari/db/schema";
import { voidActiveCardForOrder } from "./thank-you-cards";

describe("voidActiveCardForOrder", () => {
  test("voids the active card and returns its id", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx, { status: "shipped" });
      const card = await insertThankYouCard(tx, order.id);

      const result = await voidActiveCardForOrder(tx, order.id, null);
      expect(result?.id).toBe(card.id);

      const [updated] = await tx.select().from(thankYouCards).where(eq(thankYouCards.id, card.id));
      expect(updated?.status).toBe("void");
    });
  });

  test("is a no-op (returns null) when there is no active card", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx, { status: "shipped" });
      const result = await voidActiveCardForOrder(tx, order.id, null);
      expect(result).toBeNull();
    });
  });

  test("never touches an already-claimed card", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx, { status: "completed" });
      const { customers } = await import("@ammari/db/schema");
      const [customer] = await tx
        .insert(customers)
        .values({ name: "Test Customer", pdpConsentAt: new Date() })
        .returning();
      const card = await insertThankYouCard(tx, order.id, {
        status: "claimed",
        claimedByCustomerId: customer!.id,
        claimedAt: new Date(),
      });

      const result = await voidActiveCardForOrder(tx, order.id, null);
      expect(result).toBeNull();

      const [unchanged] = await tx.select().from(thankYouCards).where(eq(thankYouCards.id, card.id));
      expect(unchanged?.status).toBe("claimed");
    });
  });
});
