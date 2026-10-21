import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase, type TestTx } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertOrder, insertProductVariant, insertStaffUser, insertVariantForProduct } from "@ammari/db/test-fixtures";
import {
  auditLog,
  fabricColors,
  fabrics,
  orderItems,
  orders,
  products,
  productVariants,
  stockMovements,
  stockReservations,
} from "@ammari/db/schema";
import { ActionError, FieldError } from "../errors";
import { transitionOrderStatus, updateOrderItems } from "../orders/lifecycle";
import {
  consumeReservationsForOrder,
  DEFAULT_STOCK_HOLD_MINUTES,
  releaseReservationsForOrder,
  reserveStockForOrder,
} from "./reservations";

// docs/plans/cart-checkout.md D3, §5 step 7, session 4: stock is held for an unpaid checkout order
// in stock_reservations; the `sale` movement is written only at payment.

async function seedStock(tx: TestDatabase, sku: string, qty: number, unitCost = 100_000) {
  await tx.insert(stockMovements).values({ sku, qty, valueAmount: qty * unitCost, type: "production", refType: "manual" });
}

/** A checkout order (orders_checkout_fields_check) with one line per entry, as placeOrder will
 * write it: awaiting_payment, payment pending, unit_cost 0. */
async function insertCheckoutOrder(tx: TestDatabase, lines: readonly { sku: string; qty: number }[]) {
  const order = await insertOrder(tx, checkoutOrderValues());
  const items = await tx
    .insert(orderItems)
    .values(lines.map((line) => ({ orderId: order.id, sku: line.sku, qty: line.qty, unitPrice: 259_000, unitCost: 0 })))
    .returning();
  return { order, items };
}

function linesOf(items: readonly { id: string; sku: string; qty: number }[]) {
  return items.map((item) => ({ orderItemId: item.id, sku: item.sku, qty: item.qty }));
}

async function reservationsOf(tx: TestDatabase, orderId: string) {
  return tx.select().from(stockReservations).where(eq(stockReservations.orderId, orderId));
}

/** Runs `fn` in a savepoint and returns what it threw, so the outer test transaction survives the
 * aborted statement (same idea as the caller's own transaction rolling back). */
async function caught(tx: TestDatabase, fn: (sp: TestTx) => Promise<unknown>): Promise<unknown> {
  try {
    await tx.transaction(async (sp) => {
      await fn(sp);
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("reserveStockForOrder", () => {
  test("holds the pieces as active rows that expire after the hold window", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      await seedStock(tx, variant.sku, 3);
      const { order, items } = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 2 }]);

      const reserved = await reserveStockForOrder(tx, order.id, linesOf(items), DEFAULT_STOCK_HOLD_MINUTES);

      expect(reserved).toHaveLength(1);
      const [row] = await reservationsOf(tx, order.id);
      expect(row).toMatchObject({ orderItemId: items[0]?.id, sku: variant.sku, qty: 2, status: "active" });
      // expires_at = the transaction's now() + 75 minutes (database clock, the same clock every
      // `expires_at > now()` comparison uses).
      const [{ minutes } = { minutes: -1 }] = await tx
        .select({ minutes: sql<number>`extract(epoch from (${stockReservations.expiresAt} - now()))::int / 60` })
        .from(stockReservations)
        .where(eq(stockReservations.orderId, order.id));
      expect(minutes).toBe(75);

      // Physical stock is untouched: the ledger records real sales only.
      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      expect(movements).toHaveLength(1);
    });
  });

  test("other orders' active, unexpired reservations reduce what can be held; the error names product, colour and size", async () => {
    await withRollback(async (tx) => {
      const { variant, product, color } = await insertProductVariant(tx);
      await seedStock(tx, variant.sku, 3);
      const first = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 2 }]);
      await reserveStockForOrder(tx, first.order.id, linesOf(first.items), 75);

      const second = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 2 }]);
      const error = await caught(tx, (sp) => reserveStockForOrder(sp, second.order.id, linesOf(second.items), 75));
      expect(error).toBeInstanceOf(FieldError);
      expect((error as FieldError).field).toBe(variant.sku);
      expect((error as FieldError).message).toBe(`Stok ${product.name} warna ${color.name} ukuran M tidak cukup.`);
      // Never a count (plan §4.2: no stock counts are ever shown to buyers).
      expect((error as FieldError).message).not.toMatch(/\d/);
      expect(await reservationsOf(tx, second.order.id)).toHaveLength(0);

      // Exactly the remaining piece can still be held.
      const third = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      await expect(reserveStockForOrder(tx, third.order.id, linesOf(third.items), 75)).resolves.toHaveLength(1);
    });
  });

  test("expired, released and consumed reservations no longer hold stock", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      await seedStock(tx, variant.sku, 3);

      const expired = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      await reserveStockForOrder(tx, expired.order.id, linesOf(expired.items), 75);
      // Still `active` (no sweep ran), but past its expiry.
      await tx
        .update(stockReservations)
        .set({ expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(stockReservations.orderId, expired.order.id));

      const released = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      await reserveStockForOrder(tx, released.order.id, linesOf(released.items), 75);
      await releaseReservationsForOrder(tx, released.order.id);

      const consumed = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      await reserveStockForOrder(tx, consumed.order.id, linesOf(consumed.items), 75);
      await consumeReservationsForOrder(tx, consumed.order.id);

      const next = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 3 }]);
      await expect(reserveStockForOrder(tx, next.order.id, linesOf(next.items), 75)).resolves.toHaveLength(1);
    });
  });

  test("refuses when there is no physical stock at all", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const { order, items } = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      const error = await caught(tx, (sp) => reserveStockForOrder(sp, order.id, linesOf(items), 75));
      expect(error).toBeInstanceOf(FieldError);
    });
  });

  test("a later line that cannot be held leaves the caller's transaction to roll back every line", async () => {
    await withRollback(async (tx) => {
      const { fabric, color, variant: plenty } = await insertProductVariant(tx);
      const { variant: scarce } = await insertVariantForProduct(tx, fabric.id, color.id, { name: "Gamis Langka" }, "L");
      await seedStock(tx, plenty.sku, 5);
      await seedStock(tx, scarce.sku, 1);
      const { order, items } = await insertCheckoutOrder(tx, [
        { sku: plenty.sku, qty: 2 },
        { sku: scarce.sku, qty: 2 },
      ]);

      const error = await caught(tx, (sp) => reserveStockForOrder(sp, order.id, linesOf(items), 75));
      expect((error as FieldError).message).toBe(`Stok Gamis Langka warna ${color.name} ukuran L tidak cukup.`);
      expect(await reservationsOf(tx, order.id)).toHaveLength(0);
    });
  });

  test("an all size variant is named without a size word", async () => {
    await withRollback(async (tx) => {
      const { fabric, color } = await insertProductVariant(tx);
      const { variant } = await insertVariantForProduct(
        tx,
        fabric.id,
        color.id,
        { name: "Gamis Satu Ukuran", sizeMode: "all_size" },
        "ALLSIZE",
      );
      const { order, items } = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      const error = await caught(tx, (sp) => reserveStockForOrder(sp, order.id, linesOf(items), 75));
      expect((error as FieldError).message).toBe(`Stok Gamis Satu Ukuran warna ${color.name} ukuran All Size tidak cukup.`);
    });
  });

  test("rejects invalid input before touching anything", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      await seedStock(tx, variant.sku, 5);
      const { order, items } = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      const [item] = items;
      if (!item) throw new Error("fixture has no item");

      await expect(reserveStockForOrder(tx, order.id, [], 75)).rejects.toThrow(ActionError);
      await expect(reserveStockForOrder(tx, order.id, [{ orderItemId: item.id, sku: item.sku, qty: 0 }], 75)).rejects.toThrow(
        FieldError,
      );
      await expect(
        reserveStockForOrder(
          tx,
          order.id,
          [
            { orderItemId: item.id, sku: item.sku, qty: 1 },
            { orderItemId: randomUUID(), sku: item.sku, qty: 1 },
          ],
          75,
        ),
      ).rejects.toThrow(FieldError);
      for (const holdMinutes of [0, -5, 1.5, 24 * 60 + 1]) {
        await expect(reserveStockForOrder(tx, order.id, linesOf(items), holdMinutes)).rejects.toThrow(RangeError);
      }
      expect(await reservationsOf(tx, order.id)).toHaveLength(0);
    });
  });

  test("a line must be the order's own: the composite FK refuses a mismatched order, item or SKU", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      await seedStock(tx, variant.sku, 5);
      const mine = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      const other = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      const error = await caught(tx, (sp) => reserveStockForOrder(sp, mine.order.id, linesOf(other.items), 75));
      expect(String((error as Error).cause ?? error)).toMatch(/stock_reservations_order_item_fk/);
    });
  });

  test("an unknown SKU is refused on its own line", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const { order, items } = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      const [item] = items;
      if (!item) throw new Error("fixture has no item");
      const unknownSku = `NOPE-${randomUUID()}`;
      const error = await caught(tx, (sp) =>
        reserveStockForOrder(sp, order.id, [{ orderItemId: item.id, sku: unknownSku, qty: 1 }], 75),
      );
      expect(error).toBeInstanceOf(FieldError);
      expect((error as FieldError).field).toBe(unknownSku);
    });
  });

  test("two buyers racing for the last piece: exactly one hold succeeds", async () => {
    const { fabric, color, product, variant } = await insertProductVariant(testDb);
    await seedStock(testDb, variant.sku, 1);
    const first = await insertCheckoutOrder(testDb, [{ sku: variant.sku, qty: 1 }]);
    const second = await insertCheckoutOrder(testDb, [{ sku: variant.sku, qty: 1 }]);

    try {
      const outcomes = await Promise.allSettled([
        testDb.transaction((tx) => reserveStockForOrder(tx, first.order.id, linesOf(first.items), 75)),
        testDb.transaction((tx) => reserveStockForOrder(tx, second.order.id, linesOf(second.items), 75)),
      ]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(FieldError);

      const rows = await testDb.select().from(stockReservations).where(eq(stockReservations.sku, variant.sku));
      expect(rows).toHaveLength(1);
    } finally {
      const orderIds = [first.order.id, second.order.id];
      await testDb.delete(stockReservations).where(inArray(stockReservations.orderId, orderIds));
      await testDb.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
      await testDb.delete(orders).where(inArray(orders.id, orderIds));
      await withTriggerDisabled(testDb, "stock_movements", "prevent_stock_movement_mutation", () =>
        testDb.delete(stockMovements).where(eq(stockMovements.sku, variant.sku)),
      );
      await testDb.delete(productVariants).where(eq(productVariants.sku, variant.sku));
      await testDb.delete(products).where(eq(products.id, product.id));
      await testDb.delete(fabricColors).where(eq(fabricColors.id, color.id));
      await testDb.delete(fabrics).where(eq(fabrics.id, fabric.id));
    }
  });
});

describe("consumeReservationsForOrder / releaseReservationsForOrder", () => {
  test("consume marks every active hold of the order consumed, including one past its expiry", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      await seedStock(tx, variant.sku, 5);
      const { order, items } = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 2 }]);
      await reserveStockForOrder(tx, order.id, linesOf(items), 75);
      await tx
        .update(stockReservations)
        .set({ expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(stockReservations.orderId, order.id));

      const consumed = await consumeReservationsForOrder(tx, order.id);
      expect(consumed).toHaveLength(1);
      const [row] = await reservationsOf(tx, order.id);
      expect(row?.status).toBe("consumed");
      expect(row?.consumedAt).toBeInstanceOf(Date);
      expect(row?.releasedAt).toBeNull();

      // Replays are no-ops: a consumed hold is never released or consumed again.
      expect(await consumeReservationsForOrder(tx, order.id)).toHaveLength(0);
      expect(await releaseReservationsForOrder(tx, order.id)).toHaveLength(0);
      expect((await reservationsOf(tx, order.id))[0]?.status).toBe("consumed");
    });
  });

  test("release marks active holds released and touches no other order", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      await seedStock(tx, variant.sku, 5);
      const mine = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      const other = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      await reserveStockForOrder(tx, mine.order.id, linesOf(mine.items), 75);
      await reserveStockForOrder(tx, other.order.id, linesOf(other.items), 75);

      const released = await releaseReservationsForOrder(tx, mine.order.id);
      expect(released).toHaveLength(1);
      expect((await reservationsOf(tx, mine.order.id))[0]).toMatchObject({ status: "released", consumedAt: null });
      expect((await reservationsOf(tx, mine.order.id))[0]?.releasedAt).toBeInstanceOf(Date);
      expect((await reservationsOf(tx, other.order.id))[0]?.status).toBe("active");

      expect(await releaseReservationsForOrder(tx, mine.order.id)).toHaveLength(0);
      expect(await consumeReservationsForOrder(tx, mine.order.id)).toHaveLength(0);
    });
  });

  test("an order without reservations (every staff-entered order) is a no-op", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      expect(await consumeReservationsForOrder(tx, order.id)).toEqual([]);
      expect(await releaseReservationsForOrder(tx, order.id)).toEqual([]);
    });
  });
});

describe("transitionOrderStatus with reservations", () => {
  test("awaiting_payment -> to_ship writes the sale and consumes the order's own hold; its own hold never blocks the sale", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 1, 100_000);
      const { order, items } = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      await reserveStockForOrder(tx, order.id, linesOf(items), 75);

      // The checkout order's payment fields are the payment webhook's job (session 11); this only
      // covers the stock side of the status change.
      await transitionOrderStatus(order.id, "to_ship", staff.id, tx);

      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      expect(movements.find((m) => m.type === "sale")?.qty).toBe(-1);
      expect(movements.reduce((sum, m) => sum + m.qty, 0)).toBe(0);
      const [row] = await reservationsOf(tx, order.id);
      expect(row?.status).toBe("consumed");
      const [item] = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      expect(item?.unitCost).toBe(100_000);
    });
  });

  test("a sale that fails the physical stock check rolls back the consume too", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 1);
      const { order, items } = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      await reserveStockForOrder(tx, order.id, linesOf(items), 75);
      // A marketplace sale took the last piece meanwhile (decision 9: it stands).
      await tx.insert(stockMovements).values({ sku: variant.sku, qty: -1, valueAmount: -100_000, type: "sale", refType: "manual" });

      const error = await caught(tx, (sp) => transitionOrderStatus(order.id, "to_ship", staff.id, sp));
      expect(error).toBeInstanceOf(FieldError);
      expect((await reservationsOf(tx, order.id))[0]?.status).toBe("active");
    });
  });

  test("awaiting_payment -> cancelled releases the hold and writes no stock movement", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 2);
      const { order, items } = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 2 }]);
      await reserveStockForOrder(tx, order.id, linesOf(items), 75);

      await transitionOrderStatus(order.id, "cancelled", staff.id, tx);

      expect((await reservationsOf(tx, order.id))[0]?.status).toBe("released");
      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      expect(movements).toHaveLength(1);
      const audit = await tx.select().from(auditLog).where(eq(auditLog.entityId, order.id));
      expect(audit.map((row) => row.action)).toContain("transition_status");
    });
  });

  test("to_ship -> cancelled after payment restores stock and leaves the consumed hold alone", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 1);
      const { order, items } = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      await reserveStockForOrder(tx, order.id, linesOf(items), 75);
      await transitionOrderStatus(order.id, "to_ship", staff.id, tx);

      await transitionOrderStatus(order.id, "cancelled", staff.id, tx);

      expect((await reservationsOf(tx, order.id))[0]?.status).toBe("consumed");
      const movements = await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku));
      expect(movements.reduce((sum, m) => sum + m.qty, 0)).toBe(1);
    });
  });
});

describe("updateOrderItems on a checkout order", () => {
  test("is refused with a clear message, and the line and its hold stay as placed", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await seedStock(tx, variant.sku, 5);
      const { order, items } = await insertCheckoutOrder(tx, [{ sku: variant.sku, qty: 1 }]);
      await reserveStockForOrder(tx, order.id, linesOf(items), 75);

      const error = await caught(tx, (sp) => updateOrderItems(order.id, [{ sku: variant.sku, qty: 3, unitPrice: 1 }], staff.id, sp));
      expect(error).toBeInstanceOf(ActionError);
      expect((error as ActionError).message).toBe("Item pesanan dari checkout website tidak bisa diubah.");
      expect((await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id)))[0]?.qty).toBe(1);
      expect((await reservationsOf(tx, order.id))[0]?.status).toBe("active");
    });
  });
});
