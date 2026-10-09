import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { insertOrder, insertProductVariant, insertStaffUser, insertThankYouCard } from "@ammari/db/test-fixtures";
import { orderItems, productImages, products, thankYouCards } from "@ammari/db/schema";
import {
  claimDeadlineFromOrderDate,
  getCardPrintStatus,
  listPackingQueue,
  mintThankYouCard,
  voidActiveCardForOrder,
} from "./queries";

describe("listPackingQueue", () => {
  // Regression test for a real bug report: two manual WhatsApp orders, both `to_ship`, showed
  // correctly on /orders but an empty /packing queue. Investigation (against the owner's real
  // local db, read-only) found listPackingQueue itself already returns both orders correctly —
  // the reported symptom traced to a stale dev-server process, not a code defect. This test
  // pins down the exact scenario anyway, so a REAL future regression here fails loudly: a manual
  // WhatsApp order, `to_ship`, for a product with no images/thumbnail at all (the owner's own
  // product had none) — the kind of case an accidental INNER JOIN on optional data would drop
  // silently.
  test("a manual WhatsApp order for a product with NO images/thumbnail still appears", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx); // fixture product has no images/thumbnail
      const order = await insertOrder(tx, { channelId: "whatsapp", status: "to_ship" });
      await tx.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });

      const { rows, items } = await listPackingQueue({}, undefined, undefined, tx);

      expect(rows.map((r) => r.id)).toContain(order.id);
      const row = rows.find((r) => r.id === order.id);
      expect(row?.channelId).toBe("whatsapp");
      const orderItemsList = items.get(order.id);
      expect(orderItemsList).toHaveLength(1);
      expect(orderItemsList?.[0]?.thumbnailUrl).toBeNull();
    });
  });

  // The other half of "with/without images" — a thumbnail DOES resolve correctly when one
  // exists, confirming the productImages join is a LEFT JOIN that actually attaches data when
  // present, not just one that happens to tolerate its absence.
  test("a manual order for a product WITH a thumbnail resolves its image URL", async () => {
    await withRollback(async (tx) => {
      const { variant, product } = await insertProductVariant(tx);
      const [image] = await tx
        .insert(productImages)
        .values({ productId: product.id, fabricId: variant.fabricId, storageKey: "products/example.jpg", width: 800, height: 800 })
        .returning();
      if (!image) throw new Error("failed to insert product image fixture");
      await tx.update(products).set({ thumbnailImageId: image.id }).where(eq(products.id, product.id));

      const order = await insertOrder(tx, { channelId: "whatsapp", status: "to_ship" });
      await tx.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });

      const { items } = await listPackingQueue({}, undefined, undefined, tx);
      expect(items.get(order.id)?.[0]?.thumbnailUrl).not.toBeNull();
    });
  });

  test("does not show an order of any OTHER status", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const order = await insertOrder(tx, { channelId: "whatsapp", status: "awaiting_payment" });
      await tx.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });

      const { rows } = await listPackingQueue({}, undefined, undefined, tx);
      expect(rows.map((r) => r.id)).not.toContain(order.id);
    });
  });

  test("the channel filter narrows to exactly that channel", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const whatsappOrder = await insertOrder(tx, { channelId: "whatsapp", status: "to_ship" });
      const offlineOrder = await insertOrder(tx, { channelId: "offline", status: "to_ship" });
      await tx.insert(orderItems).values([
        { orderId: whatsappOrder.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 },
        { orderId: offlineOrder.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 },
      ]);

      const { rows } = await listPackingQueue({ channelId: "whatsapp" }, undefined, undefined, tx);
      expect(rows.map((r) => r.id)).toContain(whatsappOrder.id);
      expect(rows.map((r) => r.id)).not.toContain(offlineOrder.id);
    });
  });
});

describe("claimDeadlineFromOrderDate", () => {
  test("is 1 calendar month later, 23:59:59 WIB, for an ordinary day", () => {
    // 15 Oct 2026 12:00 WIB -> 15 Nov 2026 23:59:59 WIB = 2026-11-15T16:59:59Z.
    const deadline = claimDeadlineFromOrderDate(new Date("2026-10-15T05:00:00Z"));
    expect(deadline.toISOString()).toBe("2026-11-15T16:59:59.000Z");
  });

  test("clamps to the last day of the target month when the source day doesn't exist there (31 Jan -> last day of Feb)", () => {
    // 31 Jan 2026 is a Saturday; Jakarta date stays 31 Jan regardless of the UTC hour chosen here.
    const deadline = claimDeadlineFromOrderDate(new Date("2026-01-31T05:00:00Z"));
    // 2026 is not a leap year -> Feb has 28 days -> 28 Feb 2026 23:59:59 WIB = 2026-02-28T16:59:59Z.
    expect(deadline.toISOString()).toBe("2026-02-28T16:59:59.000Z");
  });

  test("clamps correctly across a leap year (31 Jan 2028 -> 29 Feb 2028)", () => {
    const deadline = claimDeadlineFromOrderDate(new Date("2028-01-31T05:00:00Z"));
    expect(deadline.toISOString()).toBe("2028-02-29T16:59:59.000Z");
  });

  test("rolls over the year for a December order", () => {
    const deadline = claimDeadlineFromOrderDate(new Date("2026-12-10T05:00:00Z"));
    expect(deadline.toISOString()).toBe("2027-01-10T16:59:59.000Z");
  });
});

describe("mintThankYouCard", () => {
  test("a first print creates an active card with no prior card to void", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const order = await insertOrder(tx, { status: "to_ship" });

      const minted = await mintThankYouCard(order.id, staff.id, tx);
      expect(minted.wasReprint).toBe(false);
      expect(minted.token).toHaveLength(26);

      const cards = await tx.select().from(thankYouCards).where(eq(thankYouCards.orderId, order.id));
      expect(cards).toHaveLength(1);
      expect(cards[0]!.status).toBe("active");
    });
  });

  test("reprinting voids the old active card and mints a new one with a different token", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const order = await insertOrder(tx, { status: "to_ship" });

      const first = await mintThankYouCard(order.id, staff.id, tx);
      const second = await mintThankYouCard(order.id, staff.id, tx);

      expect(second.wasReprint).toBe(true);
      expect(second.token).not.toBe(first.token);

      const cards = await tx.select().from(thankYouCards).where(eq(thankYouCards.orderId, order.id));
      expect(cards).toHaveLength(2);
      expect(cards.find((c) => c.id === first.cardId)?.status).toBe("void");
      expect(cards.find((c) => c.id === second.cardId)?.status).toBe("active");
    });
  });

  test("refuses to mint for a cancelled order", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const order = await insertOrder(tx, { status: "cancelled" });

      await expect(mintThankYouCard(order.id, staff.id, tx)).rejects.toThrow(/dibatalkan/);
    });
  });

  test("refuses to mint for a returned order", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const order = await insertOrder(tx, { status: "returned" });

      await expect(mintThankYouCard(order.id, staff.id, tx)).rejects.toThrow(/diretur/);
    });
  });

  test("the claim deadline is derived from the order's own orderDate, not the print time", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const orderDate = new Date("2026-03-10T05:00:00Z");
      const order = await insertOrder(tx, { status: "to_ship", orderDate });

      const minted = await mintThankYouCard(order.id, staff.id, tx);
      expect(minted.claimDeadline).toEqual(claimDeadlineFromOrderDate(orderDate));
    });
  });
});

describe("getCardPrintStatus", () => {
  test("reports true only for orders with an active card", async () => {
    await withRollback(async (tx) => {
      const orderWithCard = await insertOrder(tx, { status: "to_ship" });
      const orderWithoutCard = await insertOrder(tx, { status: "to_ship" });
      await insertThankYouCard(tx, orderWithCard.id);

      const status = await getCardPrintStatus([orderWithCard.id, orderWithoutCard.id], tx);
      expect(status.get(orderWithCard.id)).toBe(true);
      expect(status.get(orderWithoutCard.id)).toBe(false);
    });
  });

  test("a voided card does not count as active", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx, { status: "to_ship" });
      await insertThankYouCard(tx, order.id, { status: "void" });

      const status = await getCardPrintStatus([order.id], tx);
      expect(status.get(order.id)).toBe(false);
    });
  });
});

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
