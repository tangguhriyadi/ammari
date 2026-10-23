import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { fabrics, orderItems, products } from "../src/schema";
import { productPricingColumns } from "../src/pricing-columns";
import { resolveUnitPrice } from "../src/pricing";
import { insertOrder, insertProductVariant } from "./fixtures";
import { withRollback, type TestTx } from "./helpers";

// Per-product discount columns and their CHECKs (docs/plans/product-discount.md §4, migration
// 0036): products.discount_* and order_items.list_unit_price.

/** drizzle-orm wraps the driver error; the Postgres code and constraint are on `.cause`. */
async function violation(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause = (error instanceof Error && error.cause instanceof Error ? error.cause : error) as { code?: string; constraint_name?: string };
    return { code: cause.code, constraint: cause.constraint_name };
  }
  throw new Error("expected promise to reject, but it resolved");
}

async function insertProduct(tx: TestTx, overrides: Partial<typeof products.$inferInsert> = {}) {
  const [fabric] = await tx.insert(fabrics).values({ name: "Katun Rayon" }).returning();
  const [product] = await tx
    .insert(products)
    .values({
      name: "Gamis Diskon",
      code: `DSK${randomUUID().slice(0, 8).toUpperCase()}`,
      slug: `gamis-diskon-${randomUUID()}`,
      fabricId: fabric!.id,
      closure: "front_zip",
      sizeMode: "sized",
      basePrice: 350_000,
      ...overrides,
    })
    .returning();
  return product!;
}

const PRICE_CHECK = { code: "23514", constraint: "products_discount_price_amount_check" };

describe("products discount columns", () => {
  test("a product inserted without them has no discount", async () => {
    await withRollback(async (tx) => {
      const product = await insertProduct(tx);
      expect({
        discountPriceAmount: product.discountPriceAmount,
        discountEnabled: product.discountEnabled,
        discountStartsAt: product.discountStartsAt,
        discountEndsAt: product.discountEndsAt,
      }).toEqual({ discountPriceAmount: null, discountEnabled: false, discountStartsAt: null, discountEndsAt: null });
    });
  });

  test("stores a valid discount with a window", async () => {
    await withRollback(async (tx) => {
      const product = await insertProduct(tx, {
        discountPriceAmount: 279_000,
        discountEnabled: true,
        discountStartsAt: new Date("2026-11-01T00:00:00Z"),
        discountEndsAt: new Date("2026-11-08T00:00:00Z"),
      });
      expect(product.discountPriceAmount).toBe(279_000);
    });
  });

  test("allows exactly 1% off", async () => {
    await withRollback(async (tx) => {
      const product = await insertProduct(tx, { basePrice: 100_000, discountPriceAmount: 99_000 });
      expect(product.discountPriceAmount).toBe(99_000);
    });
  });

  test("refuses a sale price of Rp0 or below", async () => {
    await withRollback(async (tx) => {
      expect(await violation(insertProduct(tx, { discountPriceAmount: 0 }))).toEqual(PRICE_CHECK);
    });
    await withRollback(async (tx) => {
      expect(await violation(insertProduct(tx, { discountPriceAmount: -1 }))).toEqual(PRICE_CHECK);
    });
  });

  test("refuses a sale price equal to or above the base price", async () => {
    await withRollback(async (tx) => {
      expect(await violation(insertProduct(tx, { discountPriceAmount: 350_000 }))).toEqual(PRICE_CHECK);
    });
    await withRollback(async (tx) => {
      expect(await violation(insertProduct(tx, { discountPriceAmount: 400_000 }))).toEqual(PRICE_CHECK);
    });
  });

  test("refuses a discount under 1%", async () => {
    await withRollback(async (tx) => {
      expect(await violation(insertProduct(tx, { discountPriceAmount: 349_000 }))).toEqual(PRICE_CHECK);
    });
    await withRollback(async (tx) => {
      expect(await violation(insertProduct(tx, { basePrice: 100_000, discountPriceAmount: 99_001 }))).toEqual(PRICE_CHECK);
    });
  });

  test("refuses a base price edit that breaks the configured discount", async () => {
    await withRollback(async (tx) => {
      const product = await insertProduct(tx, { discountPriceAmount: 279_000 });
      expect(await violation(tx.update(products).set({ basePrice: 279_000 }).where(eq(products.id, product.id)))).toEqual(PRICE_CHECK);
    });
    await withRollback(async (tx) => {
      const product = await insertProduct(tx, { discountPriceAmount: 279_000 });
      // 281.000 -> 279.000 is 0,7% off.
      expect(await violation(tx.update(products).set({ basePrice: 281_000 }).where(eq(products.id, product.id)))).toEqual(PRICE_CHECK);
    });
    await withRollback(async (tx) => {
      const product = await insertProduct(tx, { discountPriceAmount: 279_000 });
      const [raised] = await tx.update(products).set({ basePrice: 400_000 }).where(eq(products.id, product.id)).returning();
      expect(raised?.basePrice).toBe(400_000);
    });
  });

  test("refuses the toggle on without a sale price", async () => {
    await withRollback(async (tx) => {
      expect(await violation(insertProduct(tx, { discountEnabled: true }))).toEqual({
        code: "23514",
        constraint: "products_discount_enabled_price_check",
      });
    });
  });

  test("a sale price may be kept with the toggle off", async () => {
    await withRollback(async (tx) => {
      const product = await insertProduct(tx, { discountPriceAmount: 279_000, discountEnabled: false });
      expect(product.discountEnabled).toBe(false);
    });
  });

  test("refuses an end at or before the start; either side may be empty", async () => {
    const window = { code: "23514", constraint: "products_discount_window_check" };
    const at = new Date("2026-11-01T00:00:00Z");
    await withRollback(async (tx) => {
      expect(await violation(insertProduct(tx, { discountStartsAt: at, discountEndsAt: at }))).toEqual(window);
    });
    await withRollback(async (tx) => {
      expect(
        await violation(insertProduct(tx, { discountStartsAt: at, discountEndsAt: new Date("2026-10-31T00:00:00Z") })),
      ).toEqual(window);
    });
    await withRollback(async (tx) => {
      await insertProduct(tx, { discountStartsAt: at });
      await insertProduct(tx, { discountEndsAt: at });
    });
  });

  test("productPricingColumns selects what resolveUnitPrice needs", async () => {
    await withRollback(async (tx) => {
      const product = await insertProduct(tx, {
        discountPriceAmount: 279_000,
        discountEnabled: true,
        discountEndsAt: new Date("2026-11-08T00:00:00Z"),
      });
      const [row] = await tx.select(productPricingColumns).from(products).where(eq(products.id, product.id));
      expect(row).toEqual({
        basePrice: 350_000,
        discountPriceAmount: 279_000,
        discountEnabled: true,
        discountStartsAt: null,
        discountEndsAt: new Date("2026-11-08T00:00:00Z"),
      });
      expect(resolveUnitPrice(row!, new Date("2026-11-03T00:00:00Z")).unitPrice).toBe(279_000);
    });
  });
});

describe("order_items.list_unit_price", () => {
  test("is null when not written, and may equal or exceed the charged unit price", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const { variant: other } = await insertProductVariant(tx);
      const order = await insertOrder(tx);
      const [plain] = await tx.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 }).returning();
      expect(plain?.listUnitPrice).toBeNull();
      const [discounted] = await tx
        .insert(orderItems)
        .values({ orderId: order.id, sku: other.sku, qty: 2, unitPrice: 279_000, listUnitPrice: 350_000, unitCost: 0 })
        .returning();
      expect(discounted?.listUnitPrice).toBe(350_000);
      await tx.update(orderItems).set({ listUnitPrice: 279_000 }).where(eq(orderItems.id, discounted!.id));
    });
  });

  test("refuses a list price below the charged unit price", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const order = await insertOrder(tx);
      expect(
        await violation(
          tx.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 279_000, listUnitPrice: 278_999, unitCost: 0 }),
        ),
      ).toEqual({ code: "23514", constraint: "order_items_list_unit_price_check" });
    });
  });
});
