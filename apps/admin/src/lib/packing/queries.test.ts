import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { insertOrder, insertProductVariant, insertStaffUser, insertThankYouCard } from "@ammari/db/test-fixtures";
import { orderItems, productImages, products, thankYouCards } from "@ammari/db/schema";
import {
  claimDeadlineFromOrderDate,
  getCardPrintStatus,
  listPackingQueue,
  mintThankYouCard,
  mintThankYouCardsForOrders,
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

  test("an order with an active card shows its PERSISTED sticker code, never a preview", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const { variant } = await insertProductVariant(tx);
      const order = await insertOrder(tx, { status: "to_ship", channelId: "whatsapp", orderNo: "ORD-000004-4444" });
      await tx.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });

      await mintThankYouCardsForOrders([order.id], staff.id, tx);

      const { rows } = await listPackingQueue({}, undefined, undefined, tx);
      const row = rows.find((r) => r.id === order.id);
      expect(row?.stickerCodeIsPreview).toBe(false);
      // whatsapp -> "WA"; insertProductVariant's fixture is always product "Gamis Basic" / color
      // "Black" / size "M" -> "GA"/"BL"/"M"; LAST4 from the internal order number (non-
      // marketplace channel).
      expect(row?.stickerCode).toBe("WA-GA-BL-M-4444");
    });
  });

  test("an order with no card yet shows a PREVIEW sticker code computed from its current items", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const order = await insertOrder(tx, { status: "to_ship", channelId: "whatsapp", orderNo: "ORD-000005-5555" });
      await tx.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });

      const { rows } = await listPackingQueue({}, undefined, undefined, tx);
      const row = rows.find((r) => r.id === order.id);
      expect(row?.stickerCodeIsPreview).toBe(true);
      expect(row?.stickerCode).toBe("WA-GA-BL-M-5555");
    });
  });

  test("a preview collision is caught even when the colliding order is on a DIFFERENT page (whole-queue scope, not per-page)", async () => {
    await withRollback(async (tx) => {
      const { variant: variantA } = await insertProductVariant(tx);
      const orderA = await insertOrder(tx, {
        status: "to_ship",
        channelId: "whatsapp",
        orderNo: "AAAAAA994281",
        orderDate: new Date("1970-01-01"), // guaranteed to sort first -> lands on page 1
      });
      await tx.insert(orderItems).values({ orderId: orderA.id, sku: variantA.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });

      // 9 unrelated filler orders (smallest real page size is 10 — PAGE_SIZE_OPTIONS in
      // packages/ui/src/lib/pagination.ts) dated between orderA and orderB, so orderA + fillers
      // fill page 1 and orderB lands on page 2. A different channel ("offline" -> "OFF") so a
      // filler's own code can never collide with orderA/orderB's "WA-..." codes.
      const { variant: fillerVariant } = await insertProductVariant(tx);
      for (let i = 0; i < 9; i++) {
        const filler = await insertOrder(tx, {
          status: "to_ship",
          channelId: "offline",
          orderDate: new Date(`1970-01-0${i + 2}`),
        });
        await tx.insert(orderItems).values({ orderId: filler.id, sku: fillerVariant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });
      }

      const { variant: variantB } = await insertProductVariant(tx);
      const orderB = await insertOrder(tx, {
        status: "to_ship",
        channelId: "whatsapp",
        orderNo: "BBBBBB774281",
        orderDate: new Date("1970-01-11"),
      });
      await tx.insert(orderItems).values({ orderId: orderB.id, sku: variantB.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });

      const { rows } = await listPackingQueue({}, "1", "10", tx);
      expect(rows.map((r) => r.id)).toContain(orderA.id);
      expect(rows.map((r) => r.id)).not.toContain(orderB.id); // confirms orderB really is off-page
      // Both orders' base code is "WA-GA-BL-M-4281" (same product/color/size, same LAST4) — a
      // REAL collision, caught only by scanning the whole to_ship queue, not just this page. If
      // this page's own computation couldn't see off-page orderB, it would wrongly show the
      // plain 4-char code instead.
      const rowA = rows.find((r) => r.id === orderA.id);
      expect(rowA?.stickerCode).toBe("WA-GA-BL-M-994281");
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

describe("mintThankYouCardsForOrders", () => {
  test("mints every order in the batch and persists each one's sticker code on its card", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const { variant: variantA } = await insertProductVariant(tx);
      const orderA = await insertOrder(tx, { status: "to_ship", channelId: "whatsapp", orderNo: "ORD-000001-1111" });
      await tx.insert(orderItems).values({ orderId: orderA.id, sku: variantA.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });

      const { variant: variantB } = await insertProductVariant(tx);
      const orderB = await insertOrder(tx, { status: "to_ship", channelId: "whatsapp", orderNo: "ORD-000002-2222" });
      await tx.insert(orderItems).values({ orderId: orderB.id, sku: variantB.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });

      const minted = await mintThankYouCardsForOrders([orderA.id, orderB.id], staff.id, tx);
      expect(minted).toHaveLength(2);
      const byOrderId = new Map(minted.map((m) => [m.orderId, m]));
      expect(byOrderId.get(orderA.id)?.stickerCode).toBe("WA-GA-BL-M-1111");
      expect(byOrderId.get(orderB.id)?.stickerCode).toBe("WA-GA-BL-M-2222");

      const [cardA] = await tx.select().from(thankYouCards).where(eq(thankYouCards.orderId, orderA.id));
      const [cardB] = await tx.select().from(thankYouCards).where(eq(thankYouCards.orderId, orderB.id));
      expect(cardA?.stickerCode).toBe("WA-GA-BL-M-1111");
      expect(cardB?.stickerCode).toBe("WA-GA-BL-M-2222");
    });
  });

  test("two orders in the same batch colliding on the base code both get widened to 6-char LAST4", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const { variant: variantA } = await insertProductVariant(tx);
      const orderA = await insertOrder(tx, { status: "to_ship", channelId: "whatsapp", orderNo: "AAAAAA994281" });
      await tx.insert(orderItems).values({ orderId: orderA.id, sku: variantA.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });

      const { variant: variantB } = await insertProductVariant(tx);
      const orderB = await insertOrder(tx, { status: "to_ship", channelId: "whatsapp", orderNo: "BBBBBB774281" });
      await tx.insert(orderItems).values({ orderId: orderB.id, sku: variantB.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });

      const minted = await mintThankYouCardsForOrders([orderA.id, orderB.id], staff.id, tx);
      const byOrderId = new Map(minted.map((m) => [m.orderId, m]));
      expect(byOrderId.get(orderA.id)?.stickerCode).toBe("WA-GA-BL-M-994281");
      expect(byOrderId.get(orderB.id)?.stickerCode).toBe("WA-GA-BL-M-774281");
    });
  });

  test("reprinting an order recomputes and persists a sticker code on the NEW active card", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const { variant } = await insertProductVariant(tx);
      const order = await insertOrder(tx, { status: "to_ship", channelId: "whatsapp", orderNo: "ORD-000003-3333" });
      await tx.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });

      const firstMint = await mintThankYouCardsForOrders([order.id], staff.id, tx);
      expect(firstMint[0]?.stickerCode).toBe("WA-GA-BL-M-3333");
      expect(firstMint[0]?.wasReprint).toBe(false);

      const secondMint = await mintThankYouCardsForOrders([order.id], staff.id, tx);
      expect(secondMint[0]?.wasReprint).toBe(true);
      expect(secondMint[0]?.stickerCode).toBe("WA-GA-BL-M-3333");

      const activeCards = await tx
        .select()
        .from(thankYouCards)
        .where(and(eq(thankYouCards.orderId, order.id), eq(thankYouCards.status, "active")));
      expect(activeCards).toHaveLength(1);
      expect(activeCards[0]?.stickerCode).toBe("WA-GA-BL-M-3333");

      const voidedCards = await tx
        .select()
        .from(thankYouCards)
        .where(and(eq(thankYouCards.orderId, order.id), eq(thankYouCards.status, "void")));
      expect(voidedCards).toHaveLength(1);
    });
  });
});
