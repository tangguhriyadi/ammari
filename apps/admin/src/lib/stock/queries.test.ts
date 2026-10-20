import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertProductVariant, insertStockReservation } from "@ammari/db/test-fixtures";
import { productVariants, stockMovements } from "@ammari/db/schema";
import {
  getReservedQtyBySku,
  getSkuDetail,
  listActiveReservationsForSku,
  listProductSkusForCount,
  listStockLedger,
  listStockOverview,
} from "./queries";

// The write-path tests (adjustStock, saveStockCount) moved with that code to
// packages/commerce/src/stock/ledger.test.ts.

async function seedStock(tx: TestDatabase, sku: string, qty: number, unitCost = 0) {
  await tx.insert(stockMovements).values({ sku, qty, valueAmount: qty * unitCost, type: "production", refType: "manual" });
}

describe("read-path aggregates (real numbers, not stringified bigints)", () => {
  test("getSkuDetail's currentStock sums every movement correctly", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      await seedStock(tx, variant.sku, 10);
      await seedStock(tx, variant.sku, -3);

      const detail = await getSkuDetail(variant.sku, tx);
      expect(detail?.currentStock).toBe(7);
      expect(typeof detail?.currentStock).toBe("number");
    });
  });

  test("listStockOverview's currentStock matches getSkuDetail for the same SKU", async () => {
    await withRollback(async (tx) => {
      const { variant, product } = await insertProductVariant(tx);
      await seedStock(tx, variant.sku, 4);

      const { rows } = await listStockOverview({ productId: product.id }, undefined, undefined, tx);
      const row = rows.find((r) => r.sku === variant.sku);
      expect(row?.currentStock).toBe(4);
      expect(typeof row?.currentStock).toBe("number");
    });
  });

  // Regression test for a real bug: getSkuDetail's currentStock subquery correlated
  // stock_movements to product_variants via `${stockMovements.sku} = ${productVariants.sku}`
  // inside a hand-written `(select ...)` fragment. drizzle-orm renders BOTH interpolated column
  // references as the bare, unqualified identifier "sku" in that context, so the condition was
  // actually "sku" = "sku" (always true) and the subquery summed EVERY SKU's stock in the whole
  // table, not just this one. A single-SKU test (above) can never catch this — the sum "across
  // all SKUs" and "for this one SKU" are identical when only one SKU exists in scope. This test
  // seeds a SECOND, unrelated SKU with a very different stock level specifically to make the two
  // sums diverge.
  test("getSkuDetail's currentStock is isolated to its own SKU, not summed across every SKU", async () => {
    await withRollback(async (tx) => {
      const { variant: variantA } = await insertProductVariant(tx);
      await seedStock(tx, variantA.sku, 10);

      const { variant: variantB } = await insertProductVariant(tx); // a different fabric/product/SKU
      await seedStock(tx, variantB.sku, 1000);

      const detailA = await getSkuDetail(variantA.sku, tx);
      const detailB = await getSkuDetail(variantB.sku, tx);
      expect(detailA?.currentStock).toBe(10);
      expect(detailB?.currentStock).toBe(1000);
    });
  });

  // Same root cause and same reasoning as the test above, for listProductSkusForCount — the
  // "Hitung Stok" (stock count) screen's own data source, which lists MULTIPLE SKUs of ONE
  // product side by side. This is the function where the bug is most visible: every SKU of a
  // multi-variant product showed the SAME (wrong, summed-over-all) figure, not just a single
  // mislabeled lookup.
  test("listProductSkusForCount reports each SKU's own currentStock, not one shared total", async () => {
    await withRollback(async (tx) => {
      const { fabric, color, product, variant: variantM } = await insertProductVariant(tx); // size "M" by default
      await seedStock(tx, variantM.sku, 7);

      // A SECOND variant of the SAME product (not insertVariantForProduct, which creates its
      // own separate product) — the whole point is two SKUs under one productId, since that's
      // exactly what the "Hitung Stok" screen lists side by side.
      const [variantL] = await tx
        .insert(productVariants)
        .values({
          sku: `SKU-${product.code}-L`,
          productId: product.id,
          fabricId: fabric.id,
          fabricColorId: color.id,
          closure: product.closure,
          size: "L",
        })
        .returning();
      if (!variantL) throw new Error("failed to insert second variant fixture");
      await seedStock(tx, variantL.sku, 2);

      const skus = await listProductSkusForCount(product.id, tx);
      const rowM = skus.find((row) => row.sku === variantM.sku);
      const rowL = skus.find((row) => row.sku === variantL.sku);
      expect(rowM?.currentStock).toBe(7);
      expect(rowL?.currentStock).toBe(2);
    });
  });

  test("listStockLedger's running balance is correct across multiple movements, newest first", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const base = Date.now();
      await tx.insert(stockMovements).values([
        { sku: variant.sku, qty: 10, valueAmount: 0, type: "production", refType: "manual", createdAt: new Date(base) },
        { sku: variant.sku, qty: -3, valueAmount: 0, type: "sale", refType: "manual", createdAt: new Date(base + 1000) },
        { sku: variant.sku, qty: 2, valueAmount: 0, type: "return", refType: "manual", createdAt: new Date(base + 2000) },
      ]);

      const { rows } = await listStockLedger(variant.sku, undefined, undefined, tx);
      // Newest first: +2 (balance 9) -> -3 (balance 7) -> +10 (balance 10).
      expect(rows.map((r) => r.qty)).toEqual([2, -3, 10]);
      expect(rows.map((r) => r.runningBalance)).toEqual([9, 7, 10]);
      expect(rows.every((r) => typeof r.runningBalance === "number")).toBe(true);
    });
  });
});

// docs/plans/cart-checkout.md §7 (session 4): admin shows a read-only "Dipesan" figure from active
// checkout holds. Physical stock ("currentStock") never changes because of a hold (D4).
describe("Dipesan (active stock holds)", () => {
  test("getReservedQtyBySku sums only active, unexpired holds and omits SKUs without any", async () => {
    await withRollback(async (tx) => {
      const { variant, product, color, fabric } = await insertProductVariant(tx);
      const [other] = await tx
        .insert(productVariants)
        .values({ sku: `SKU-${randomUUID()}`, productId: product.id, fabricId: fabric.id, fabricColorId: color.id, closure: product.closure, size: "L" })
        .returning();
      if (!other) throw new Error("failed to insert second variant fixture");
      await seedStock(tx, variant.sku, 10);
      await seedStock(tx, other.sku, 10);
      await insertStockReservation(tx, { sku: variant.sku, qty: 2 });
      await insertStockReservation(tx, { sku: variant.sku, qty: 1 });
      await insertStockReservation(tx, { sku: variant.sku, qty: 5, expiresAt: new Date(Date.now() - 60_000) });
      await insertStockReservation(tx, { sku: variant.sku, qty: 4, status: "released" });
      await insertStockReservation(tx, { sku: other.sku, qty: 3, status: "consumed" });

      const reserved = await getReservedQtyBySku([variant.sku, other.sku], tx);
      expect(reserved.get(variant.sku)).toBe(3);
      expect(typeof reserved.get(variant.sku)).toBe("number");
      expect(reserved.has(other.sku)).toBe(false);
      expect(await getReservedQtyBySku([], tx)).toEqual(new Map());

      // Physical stock is untouched by holds.
      expect((await getSkuDetail(variant.sku, tx))?.currentStock).toBe(10);
    });
  });

  test("listActiveReservationsForSku lists the holding orders, soonest expiry first", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      await seedStock(tx, variant.sku, 10);
      const later = await insertStockReservation(tx, { sku: variant.sku, qty: 2, expiresAt: new Date(Date.now() + 70 * 60_000) });
      const sooner = await insertStockReservation(tx, { sku: variant.sku, qty: 1, expiresAt: new Date(Date.now() + 10 * 60_000) });
      await insertStockReservation(tx, { sku: variant.sku, qty: 5, expiresAt: new Date(Date.now() - 60_000) });
      await insertStockReservation(tx, { sku: variant.sku, qty: 4, status: "released" });

      const rows = await listActiveReservationsForSku(variant.sku, tx);
      expect(rows.map((row) => [row.orderNo, row.qty])).toEqual([
        [sooner.order.orderNo, 1],
        [later.order.orderNo, 2],
      ]);
      expect(rows[0]?.orderId).toBe(sooner.order.id);
      expect(rows[0]?.expiresAt).toBeInstanceOf(Date);
    });
  });
});
