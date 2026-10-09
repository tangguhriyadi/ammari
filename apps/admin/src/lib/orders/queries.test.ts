import { eq, inArray } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { insertProductVariant, insertStaffUser, insertThankYouCard } from "@ammari/db/test-fixtures";
import { fabricColors, fabrics, orderItems, orders, products, productVariants, stockMovements, thankYouCards } from "@ammari/db/schema";
import { createOrder, getOrderDetail, transitionOrderStatus, updateOrderItems } from "./queries";
import { generateOrderNumber } from "./order-number";

async function seedStock(tx: TestDatabase, sku: string, qty: number, unitCost: number) {
  await tx.insert(stockMovements).values({ sku, qty, valueAmount: qty * unitCost, type: "production", refType: "manual" });
}

describe("createOrder", () => {
  test("an order starting at to_ship decrements stock and snapshots unit_cost at the current average", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 10, 100_000); // avg Rp100.000/pcs

      const order = await createOrder(
        {
          channelId: "whatsapp",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 2, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 10_000,
          status: "to_ship",
        },
        staff.id,
        tx,
      );

      expect(order.orderNo).toMatch(/^ORD-\d{6}-\d{4}$/);
      expect(order.subtotalAmount).toBe(518_000);
      expect(order.totalAmount).toBe(528_000);

      const detail = await getOrderDetail(order.id, tx);
      expect(detail?.items).toHaveLength(1);
      expect(detail?.items[0]!.unitCost).toBe(100_000);

      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      const sale = movements.find((m) => m.type === "sale");
      expect(sale?.qty).toBe(-2);
      expect(sale?.valueAmount).toBe(-200_000);

      const totalQty = movements.reduce((sum, m) => sum + m.qty, 0);
      expect(totalQty).toBe(8);
    });
  });

  test("an awaiting_payment order does not touch stock at creation", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 5, 100_000);

      const order = await createOrder(
        {
          channelId: "instagram",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 2, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 0,
          status: "awaiting_payment",
        },
        staff.id,
        tx,
      );

      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      expect(movements).toHaveLength(1); // only the seed — no sale posted yet

      const detail = await getOrderDetail(order.id, tx);
      expect(detail?.items[0]!.unitCost).toBe(0); // placeholder, not yet snapshotted
    });
  });

  test("rejects when requested qty exceeds available stock, naming the SKU", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 1, 100_000);

      await expect(
        createOrder(
          {
            channelId: "offline",
            orderDate: "2026-10-09",
            items: [{ sku: variant.sku, qty: 5, unitPrice: 259_000 }],
            discountAmount: 0,
            shippingAmount: 0,
            status: "to_ship",
          },
          staff.id,
          tx,
        ),
      ).rejects.toMatchObject({ field: variant.sku });
    });
  });

  test("requires channel_order_no for shopee/tiktok but not for manual channels", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 10, 100_000);

      await expect(
        createOrder(
          {
            channelId: "shopee",
            orderDate: "2026-10-09",
            items: [{ sku: variant.sku, qty: 1, unitPrice: 259_000 }],
            discountAmount: 0,
            shippingAmount: 0,
            status: "to_ship",
          },
          staff.id,
          tx,
        ),
      ).rejects.toMatchObject({ field: "channelOrderNo" });

      // Same input, manual channel — no channel_order_no needed.
      const order = await createOrder(
        {
          channelId: "offline",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 1, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 0,
          status: "to_ship",
        },
        staff.id,
        tx,
      );
      expect(order.channelOrderNo).toBeNull();
    });
  });

  test("a re-import-shaped insert for the same (channel, channel_order_no) hits the unique key, not a duplicate", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 10, 100_000);

      await createOrder(
        {
          channelId: "shopee",
          channelOrderNo: "SHOPEE-123",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 1, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 0,
          status: "to_ship",
        },
        staff.id,
        tx,
      );

      await expect(
        createOrder(
          {
            channelId: "shopee",
            channelOrderNo: "SHOPEE-123",
            orderDate: "2026-10-09",
            items: [{ sku: variant.sku, qty: 1, unitPrice: 259_000 }],
            discountAmount: 0,
            shippingAmount: 0,
            status: "to_ship",
          },
          staff.id,
          tx,
        ),
      ).rejects.toMatchObject({ field: "channelOrderNo" });
    });
  });

  test("rejects a duplicate SKU within the same order", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 10, 100_000);

      await expect(
        createOrder(
          {
            channelId: "offline",
            orderDate: "2026-10-09",
            items: [
              { sku: variant.sku, qty: 1, unitPrice: 259_000 },
              { sku: variant.sku, qty: 1, unitPrice: 259_000 },
            ],
            discountAmount: 0,
            shippingAmount: 0,
            status: "to_ship",
          },
          staff.id,
          tx,
        ),
      ).rejects.toMatchObject({ field: variant.sku });
    });
  });
});

describe("generateOrderNumber", () => {
  test("a fresh month's first order number is -0001, 4 digits, zero-padded", async () => {
    await withRollback(async (tx) => {
      const orderNo = await generateOrderNumber(tx, new Date("2026-10-31T17:30:00Z")); // = 00:30 WIB on 1 Nov
      expect(orderNo).toBe("ORD-202611-0001");
    });
  });

  test("two orders created in the same month get sequential numbers", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      const makeOrder = () =>
        createOrder(
          {
            channelId: "offline",
            orderDate: "2026-10-09",
            items: [{ sku: variant.sku, qty: 1, unitPrice: 100_000 }],
            discountAmount: 0,
            shippingAmount: 0,
            status: "awaiting_payment", // no stock needed — this test is purely about order_no
          },
          staff.id,
          tx,
        );
      const first = await makeOrder();
      const second = await makeOrder();
      expect(second.orderNo).not.toBe(first.orderNo);
      const firstSeq = Number.parseInt(first.orderNo.split("-")[2]!, 10);
      const secondSeq = Number.parseInt(second.orderNo.split("-")[2]!, 10);
      expect(secondSeq).toBe(firstSeq + 1);
    });
  });

  test("concurrent order creation (5 at once) yields 5 distinct sequential numbers, no errors", async () => {
    // Real commits, not withRollback's single shared transaction — genuine advisory-lock
    // contention needs separate connections/transactions (same reasoning as production's own
    // generateBatchNumber concurrency test), so cleanup here is manual.
    const { fabric, color, product, variant } = await insertProductVariant(testDb);
    const staff = await insertStaffUser(testDb);
    let createdIds: string[] = [];
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          createOrder(
            {
              channelId: "offline",
              orderDate: "2026-10-09",
              items: [{ sku: variant.sku, qty: 1, unitPrice: 100_000 }],
              discountAmount: 0,
              shippingAmount: 0,
              status: "awaiting_payment",
            },
            staff.id,
            testDb,
          ),
        ),
      );
      createdIds = results.map((order) => order.id);
      const orderNos = results.map((order) => order.orderNo).sort();
      expect(new Set(orderNos).size).toBe(5);
      const sequences = orderNos.map((orderNo) => Number.parseInt(orderNo.split("-")[2]!, 10));
      expect(sequences.sort((a, b) => a - b)).toEqual(Array.from({ length: 5 }, (_, i) => Math.min(...sequences) + i));
    } finally {
      await testDb.delete(orders).where(inArray(orders.id, createdIds)); // cascades order_items
      await testDb.delete(productVariants).where(eq(productVariants.sku, variant.sku));
      await testDb.delete(products).where(eq(products.id, product.id));
      await testDb.delete(fabricColors).where(eq(fabricColors.id, color.id));
      await testDb.delete(fabrics).where(eq(fabrics.id, fabric.id));
    }
  });
});

describe("transitionOrderStatus", () => {
  test("awaiting_payment -> to_ship decrements stock and snapshots unit_cost", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 10, 100_000);

      const order = await createOrder(
        {
          channelId: "offline",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 3, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 0,
          status: "awaiting_payment",
        },
        staff.id,
        tx,
      );

      const updated = await transitionOrderStatus(order.id, "to_ship", staff.id, tx);
      expect(updated.status).toBe("to_ship");

      const detail = await getOrderDetail(order.id, tx);
      expect(detail?.items[0]!.unitCost).toBe(100_000);

      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      const totalQty = movements.reduce((sum, m) => sum + m.qty, 0);
      expect(totalQty).toBe(7);
    });
  });

  test("to_ship -> cancelled restores stock exactly (whole item), leaving the average unaffected", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 10, 100_000); // avg 100_000

      const order = await createOrder(
        {
          channelId: "offline",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 4, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 0,
          status: "to_ship",
        },
        staff.id,
        tx,
      );

      await transitionOrderStatus(order.id, "cancelled", staff.id, tx);

      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      const totalQty = movements.reduce((sum, m) => sum + m.qty, 0);
      const totalValue = movements.reduce((sum, m) => sum + m.valueAmount, 0);
      expect(totalQty).toBe(10); // fully restored
      expect(totalValue).toBe(1_000_000); // original value basis restored exactly, average unaffected

      const returnMovement = movements.find((m) => m.type === "return");
      expect(returnMovement?.qty).toBe(4);
      expect(returnMovement?.valueAmount).toBe(400_000); // exact negation of the original sale
    });
  });

  test("shipped -> returned also restores stock exactly", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 10, 50_000);

      const order = await createOrder(
        {
          channelId: "offline",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 2, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 0,
          status: "to_ship",
        },
        staff.id,
        tx,
      );
      await transitionOrderStatus(order.id, "shipped", staff.id, tx);
      await transitionOrderStatus(order.id, "returned", staff.id, tx);

      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      const totalQty = movements.reduce((sum, m) => sum + m.qty, 0);
      expect(totalQty).toBe(10);
    });
  });

  test("awaiting_payment -> cancelled does not touch stock (nothing was ever decremented)", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 5, 50_000);

      const order = await createOrder(
        {
          channelId: "offline",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 2, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 0,
          status: "awaiting_payment",
        },
        staff.id,
        tx,
      );
      await transitionOrderStatus(order.id, "cancelled", staff.id, tx);

      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      expect(movements).toHaveLength(1); // only the seed
    });
  });

  test("disallows shipped -> cancelled (refused deliveries go through returned)", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 5, 50_000);

      const order = await createOrder(
        {
          channelId: "offline",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 1, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 0,
          status: "to_ship",
        },
        staff.id,
        tx,
      );
      await transitionOrderStatus(order.id, "shipped", staff.id, tx);

      await expect(transitionOrderStatus(order.id, "cancelled", staff.id, tx)).rejects.toThrow();
    });
  });

  test("disallows skipping a status (awaiting_payment -> shipped directly)", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 5, 50_000);

      const order = await createOrder(
        {
          channelId: "offline",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 1, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 0,
          status: "awaiting_payment",
        },
        staff.id,
        tx,
      );

      await expect(transitionOrderStatus(order.id, "shipped", staff.id, tx)).rejects.toThrow();
    });
  });

  test("two concurrent cancellations of the same order land exactly once, never double-restoring stock", async () => {
    // Real commits, not withRollback's single shared transaction — genuine row-lock contention
    // needs separate connections/transactions (same reasoning as stock/queries.test.ts's own
    // "two concurrent negative adjustments" test), so cleanup here is manual.
    const { fabric, color, product, variant } = await insertProductVariant(testDb);
    const staff = await insertStaffUser(testDb);
    await seedStock(testDb, variant.sku, 10, 50_000);

    const order = await createOrder(
      {
        channelId: "offline",
        orderDate: "2026-10-09",
        items: [{ sku: variant.sku, qty: 4, unitPrice: 259_000 }],
        discountAmount: 0,
        shippingAmount: 0,
        status: "to_ship",
      },
      staff.id,
      testDb,
    );

    try {
      // Both calls read the same "to_ship" starting point; without the row lock + guarded
      // UPDATE in transitionOrderStatus, both could pass canTransitionOrderStatus and both
      // attempt to restore stock for the same order — exactly the check-then-write race
      // CLAUDE.md forbids.
      const outcomes = await Promise.allSettled([
        transitionOrderStatus(order.id, "cancelled", staff.id, testDb),
        transitionOrderStatus(order.id, "cancelled", staff.id, testDb),
      ]);
      const succeeded = outcomes.filter((o) => o.status === "fulfilled");
      const failed = outcomes.filter((o) => o.status === "rejected");
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);

      const movements = await testDb.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      const totalQty = movements.reduce((sum, m) => sum + m.qty, 0);
      expect(totalQty).toBe(10); // restored exactly once, not twice
      expect(movements.filter((m) => m.type === "return")).toHaveLength(1);
    } finally {
      await testDb.delete(orders).where(eq(orders.id, order.id)); // cascades order_items
      await withTriggerDisabled(testDb, "stock_movements", "prevent_stock_movement_mutation", () =>
        testDb.delete(stockMovements).where(eq(stockMovements.sku, variant.sku)),
      );
      await testDb.delete(productVariants).where(eq(productVariants.sku, variant.sku));
      await testDb.delete(products).where(eq(products.id, product.id));
      await testDb.delete(fabricColors).where(eq(fabricColors.id, color.id));
      await testDb.delete(fabrics).where(eq(fabrics.id, fabric.id));
    }
  });

  test("cancelling an order with an active thank-you card voids it in the same transaction", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 5, 50_000);
      const order = await createOrder(
        {
          channelId: "offline",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 1, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 0,
          status: "to_ship",
        },
        staff.id,
        tx,
      );
      const card = await insertThankYouCard(tx, order.id);

      await transitionOrderStatus(order.id, "cancelled", staff.id, tx);

      const [updatedCard] = await tx.select().from(thankYouCards).where(eq(thankYouCards.id, card.id));
      expect(updatedCard?.status).toBe("void");
    });
  });

  test("cancelling an order with NO thank-you card is a no-op for thank_you_cards, not an error", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 5, 50_000);
      const order = await createOrder(
        {
          channelId: "offline",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 1, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 0,
          status: "to_ship",
        },
        staff.id,
        tx,
      );

      const updated = await transitionOrderStatus(order.id, "cancelled", staff.id, tx);
      expect(updated.status).toBe("cancelled");
    });
  });

  test("cancelling an order never touches an already-claimed card", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 5, 50_000);
      const order = await createOrder(
        {
          channelId: "offline",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 1, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 0,
          status: "to_ship",
        },
        staff.id,
        tx,
      );
      await transitionOrderStatus(order.id, "shipped", staff.id, tx);
      const { customers } = await import("@ammari/db/schema");
      const [customer] = await tx.insert(customers).values({ name: "Test Customer" }).returning();
      const card = await insertThankYouCard(tx, order.id, {
        status: "claimed",
        claimedByCustomerId: customer!.id,
        claimedAt: new Date(),
      });

      await transitionOrderStatus(order.id, "returned", staff.id, tx);

      const [unchangedCard] = await tx.select().from(thankYouCards).where(eq(thankYouCards.id, card.id));
      expect(unchangedCard?.status).toBe("claimed");
    });
  });

  test("a shipped transition stamps courier/trackingNumber when provided", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 5, 50_000);
      const order = await createOrder(
        {
          channelId: "offline",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 1, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 0,
          status: "to_ship",
        },
        staff.id,
        tx,
      );

      const updated = await transitionOrderStatus(order.id, "shipped", staff.id, tx, { courier: "JNE", trackingNumber: "JX123" });
      expect(updated.courier).toBe("JNE");
      expect(updated.trackingNumber).toBe("JX123");
    });
  });

  test("a bulk shipped transition (no courier/trackingNumber) leaves both null", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 5, 50_000);
      const order = await createOrder(
        {
          channelId: "offline",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 1, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 0,
          status: "to_ship",
        },
        staff.id,
        tx,
      );

      const updated = await transitionOrderStatus(order.id, "shipped", staff.id, tx);
      expect(updated.courier).toBeNull();
      expect(updated.trackingNumber).toBeNull();
    });
  });
});

describe("updateOrderItems", () => {
  test("allows editing items while awaiting_payment, recomputing totals", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 5, 50_000);

      const order = await createOrder(
        {
          channelId: "offline",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 1, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 10_000,
          status: "awaiting_payment",
        },
        staff.id,
        tx,
      );

      const updated = await updateOrderItems(order.id, [{ sku: variant.sku, qty: 3, unitPrice: 259_000 }], staff.id, tx);
      expect(updated.subtotalAmount).toBe(777_000);
      expect(updated.totalAmount).toBe(787_000);

      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      expect(items).toHaveLength(1);
      expect(items[0]!.qty).toBe(3);
    });
  });

  test("rejects editing items once the order is past awaiting_payment", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 5, 50_000);

      const order = await createOrder(
        {
          channelId: "offline",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 1, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 0,
          status: "to_ship",
        },
        staff.id,
        tx,
      );

      await expect(updateOrderItems(order.id, [{ sku: variant.sku, qty: 2, unitPrice: 259_000 }], staff.id, tx)).rejects.toThrow(
        /menunggu bayar/,
      );
    });
  });
});
