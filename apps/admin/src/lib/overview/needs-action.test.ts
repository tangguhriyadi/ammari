import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertOrder, insertProductVariant, insertStaffUser, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { costComponents, productVariants, stockMovements } from "@ammari/db/schema";
import { recordFabricPurchase } from "@/lib/inventory/fabric-stock";
import { createDraft, listBatches, postBatch } from "@/lib/production/queries";
import { recordBatchPayment } from "@/lib/supplier-payments/batch-payments";
import type { StoredPrivateFile } from "@/lib/supplier-payments/store-upload";
import {
  getAttentionOrders,
  getAwaitingPaymentOrders,
  getLowStock,
  getToShipOrders,
  getUnpaidProduction,
  lateToShipCutoff,
} from "./needs-action";

// docs/plans/dashboard-overview.md §5 (D8, D10). These blocks are not tied to a period, so they see
// whatever else ammari_test holds: the order tests run "now" in January 2001, before every other
// order, and compare counts against a baseline where a block is global.

const NOW = new Date("2001-01-10T05:00:00Z"); // 12:00 WIB, 10 Jan 2001

describe("lateToShipCutoff (D10)", () => {
  test("late means more than 2 Jakarta days: 00:00 WIB two days ago, whatever the hour now", () => {
    expect(lateToShipCutoff(NOW).toISOString()).toBe("2001-01-07T17:00:00.000Z"); // 8 Jan 00:00 WIB
    // 00:30 WIB on 10 Jan is still 9 Jan in UTC; the Jakarta day decides.
    expect(lateToShipCutoff(new Date("2001-01-09T17:30:00Z")).toISOString()).toBe("2001-01-07T17:00:00.000Z");
  });
});

describe("order blocks", () => {
  test("Siap Kirim: count, late count, oldest first with the late ones flagged", async () => {
    await withRollback(async (tx) => {
      const before = await getToShipOrders(NOW, tx);
      const late = await insertOrder(tx, { status: "to_ship", orderDate: new Date("2001-01-07T03:00:00Z") }); // 7 Jan 10:00 WIB
      const lateEvening = await insertOrder(tx, { status: "to_ship", orderDate: new Date("2001-01-07T16:30:00Z") }); // 7 Jan 23:30 WIB
      const onTime = await insertOrder(tx, { status: "to_ship", orderDate: new Date("2001-01-07T17:30:00Z") }); // 8 Jan 00:30 WIB
      await insertOrder(tx, { status: "shipped", orderDate: new Date("2001-01-01T03:00:00Z") });

      const result = await getToShipOrders(NOW, tx);
      expect(result.count).toBe(before.count + 3);
      expect(result.lateCount).toBe(before.lateCount + 2);
      expect(result.rows.map((row) => [row.id, row.isLate])).toEqual([
        [late.id, true],
        [lateEvening.id, true],
        [onTime.id, false],
      ]);
      expect(result.rows[0]).toMatchObject({ orderNo: late.orderNo, channelName: expect.any(String) });
    });
  });

  test("Perlu dicek: flagged orders only, newest first", async () => {
    await withRollback(async (tx) => {
      const before = await getAttentionOrders(tx);
      const flagged = await insertOrder(tx, { status: "to_ship", needsAttention: ["paid_after_cancel"] });
      await insertOrder(tx, { status: "to_ship" });
      const result = await getAttentionOrders(tx);
      expect(result.count).toBe(before.count + 1);
      expect(result.rows.map((row) => row.id)).toContain(flagged.id);
    });
  });

  test("Menunggu Bayar (D8): manual unpaid over 24 hours, checkout expiring within 15 minutes", async () => {
    await withRollback(async (tx) => {
      const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);
      const stale = await insertOrder(tx, { status: "awaiting_payment", orderDate: minutes(-25 * 60) });
      await insertOrder(tx, { status: "awaiting_payment", orderDate: minutes(-23 * 60) }); // not yet 24 hours
      await insertOrder(tx, { status: "to_ship", orderDate: minutes(-48 * 60) }); // paid
      const checkout = (expiresAt: Date) =>
        insertOrder(tx, { ...checkoutOrderValues(), orderDate: minutes(-50), paymentExpiresAt: expiresAt, recipientName: "Pembeli Web" });
      const soon = await checkout(minutes(10));
      const sooner = await checkout(minutes(2));
      await checkout(minutes(20)); // not yet
      const edge = await checkout(minutes(15)); // exactly 15 minutes left: included
      await checkout(NOW); // closing this instant: no longer open
      await checkout(minutes(-1)); // already past: the sweeper's

      const result = await getAwaitingPaymentOrders(NOW, tx);
      expect(result.staleManualCount).toBe(1);
      expect(result.expiringCheckoutCount).toBe(3);
      expect(result.rows.map((row) => [row.id, row.kind])).toEqual([
        [sooner.id, "expiring_checkout"],
        [soon.id, "expiring_checkout"],
        [edge.id, "expiring_checkout"],
      ]);
      // Checkout rows fill the first 3; the stale manual order comes after them (see the next call).
      expect((await getAwaitingPaymentOrders(new Date(NOW.getTime() + 16 * 60_000), tx)).rows.map((row) => row.id)).toContain(stale.id);
      // A checkout order shows the name typed at checkout (orderBuyerNameSql's rule).
      expect(result.rows[0]).toMatchObject({ buyerName: "Pembeli Web", paymentExpiresAt: minutes(2) });
    });
  });
});

describe("getLowStock", () => {
  test("active variants with a minimum, at or below it; out of stock first; no minimum or inactive never listed", async () => {
    await withRollback(async (tx) => {
      const before = await getLowStock(tx);
      const { fabric, color, variant: out } = await insertProductVariant(tx);
      const variant = async (minStockQty: number, stock: number, isActive = true) => {
        const created = (await insertVariantForProduct(tx, fabric.id, color.id)).variant;
        await tx.update(productVariants).set({ minStockQty, isActive }).where(eq(productVariants.sku, created.sku));
        if (stock !== 0) await tx.insert(stockMovements).values({ sku: created.sku, qty: stock, valueAmount: 0, type: "production", refType: "manual" });
        return created;
      };
      await tx.update(productVariants).set({ minStockQty: 5 }).where(eq(productVariants.sku, out.sku));
      const low = await variant(4, 2); // 50%
      const atMin = await variant(3, 3); // 100%, still menipis
      await variant(3, 4); // above the minimum
      await variant(0, 0); // no minimum: never listed, even at 0
      await variant(5, 0, false); // inactive

      const result = await getLowStock(tx, 1_000);
      expect(result.outCount).toBe(before.outCount + 1);
      expect(result.lowCount).toBe(before.lowCount + 2);
      const ours = result.rows.filter((row) => [out.sku, low.sku, atMin.sku].includes(row.sku));
      expect(ours.map((row) => [row.sku, row.currentStock, row.minStockQty])).toEqual([
        [out.sku, 0, 5],
        [low.sku, 2, 4],
        [atMin.sku, 3, 3],
      ]);
      const ratios = result.rows.map((row) => Math.max(row.currentStock, 0) / row.minStockQty);
      expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
      expect((await getLowStock(tx)).rows.length).toBeLessThanOrEqual(5);
    });
  });
});

function storedFile(): StoredPrivateFile {
  const id = randomUUID();
  return {
    id,
    purpose: "payment_proof",
    storageKey: `test/payment_proof/2026/10/${id}.jpg`,
    processed: {
      body: Buffer.alloc(0),
      contentType: "image/jpeg",
      extension: "jpg",
      byteSize: 1234,
      sha256: createHash("sha256").update(id).digest("hex"),
      originalFilename: "bukti.jpg",
      originalContentType: "image/jpeg",
      originalByteSize: 2345,
      originalSha256: createHash("sha256").update(randomUUID()).digest("hex"),
      jpegQuality: 82,
    },
  };
}

async function postedBatch(tx: TestDatabase, staffId: string, producedAt: string, sewingAmount: number) {
  const { fabric, variant } = await insertProductVariant(tx);
  await recordFabricPurchase({ fabricId: fabric.id, qty: 20, totalAmountPaid: 2_000_000, purchasedAt: "2000-12-01" }, null, tx);
  const [component] = await tx.insert(costComponents).values({ name: `Jahit ${randomUUID().slice(0, 8)}`, unit: "pcs", costType: "fixed" }).returning();
  const batch = await createDraft(
    { fabricId: fabric.id, producedAt, fabricYards: 5, lines: [{ sku: variant.sku, qty: 5 }], extraCosts: [{ costComponentId: component!.id, unitPrice: sewingAmount, supplierId: null }] },
    staffId,
    tx,
  );
  await postBatch(batch.id, staffId, tx);
  return batch;
}

describe("getUnpaidProduction", () => {
  test("posted batches not fully paid, agreeing with listBatches' Belum bayar and DP filters; amounts only with finance", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const before = await getUnpaidProduction({ canViewProfit: true }, tx);
      const unpaid = await postedBatch(tx, staff.id, "2000-01-02", 50_000);
      const partial = await postedBatch(tx, staff.id, "2000-01-03", 50_000);
      const paid = await postedBatch(tx, staff.id, "2000-01-04", 50_000);
      const pay = (batchId: string, amount: number) =>
        recordBatchPayment({ productionBatchId: batchId, supplierId: null, paidAt: "2000-01-05", amount, method: "cash" }, storedFile(), staff.id, tx);
      await pay(partial.id, 20_000);
      await pay(paid.id, 50_000);

      const result = await getUnpaidProduction({ canViewProfit: true }, tx);
      expect(result.unpaidCount).toBe(before.unpaidCount + 1);
      expect(result.partialCount).toBe(before.partialCount + 1);
      expect(result.remainingTotal).toBe((before.remainingTotal ?? 0) + 50_000 + 30_000);
      expect(result.rows.slice(0, 2).map((row) => [row.id, row.status, row.remaining])).toEqual([
        [unpaid.id, "unpaid", 50_000],
        [partial.id, "partial", 30_000],
      ]);

      const listed = async (payment: "unpaid" | "partial") => (await listBatches({ payment }, undefined, undefined, tx)).pagination.totalCount;
      expect(result.unpaidCount).toBe(await listed("unpaid"));
      expect(result.partialCount).toBe(await listed("partial"));

      const withoutFinance = await getUnpaidProduction({ canViewProfit: false }, tx);
      expect(withoutFinance.remainingTotal).toBeNull();
      expect(withoutFinance.rows.every((row) => row.remaining === null)).toBe(true);
      expect(withoutFinance.unpaidCount).toBe(result.unpaidCount);
    });
  });
});
