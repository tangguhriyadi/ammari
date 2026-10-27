import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertFabricColor, insertOrder, insertProductVariant, insertStaffUser, insertVariantForProduct, shippingQuoteValues } from "@ammari/db/test-fixtures";
import { shopeeRows, xlsxBytes, type FixtureOrder } from "../../../test/marketplace-fixtures";
import { commitImport } from "../marketplace-import/commit";
import { parseMarketplaceFile } from "../marketplace-import/parse-file";
import { planImport } from "../marketplace-import/plan";
import {
  orderChannelFees,
  orderItems,
  orders,
  payments,
  productTypes,
  productVariants,
  salesGoal,
  stockMovements,
  type ChannelFeeComponent,
  type OrderPaymentStatus,
  type OrderStatus,
} from "@ammari/db/schema";
import { jakartaMidnight } from "@ammari/commerce/jakarta-day";
import { getChannelBreakdown, getGoalCumulative, getGoalProgress, getPeriodTotals, getProductTypeBreakdown, getSalesGoal, getSalesSeries, getTopProducts } from "./queries";

// docs/plans/dashboard-overview.md §1 (D1: omzet = Siap Kirim / Dikirim / Selesai, after voucher,
// without ongkir, partial refunds subtracted; D6: voucher prorated across lines). Every order here
// is dated in 2031, so whatever else ammari_test holds never falls inside a range under test.

const DAY = { start: jakartaMidnight("2031-03-10"), end: jakartaMidnight("2031-03-11") };
const IN_DAY = new Date("2031-03-10T05:00:00Z"); // 12:00 WIB

interface Line {
  sku: string;
  qty: number;
  unitPrice: number;
  unitCost: number;
}

async function recordOrder(
  tx: TestDatabase,
  lines: readonly Line[],
  values: Partial<typeof orders.$inferInsert> & { status: OrderStatus },
): Promise<string> {
  const subtotalAmount = lines.reduce((sum, line) => sum + line.qty * line.unitPrice, 0);
  const order = await insertOrder(tx, { orderDate: IN_DAY, subtotalAmount, ...values });
  await tx.insert(orderItems).values(lines.map((line) => ({ orderId: order.id, ...line })));
  return order.id;
}

/** A paid web checkout order in a given payment state, with one payment attempt carrying
 * `refundedAmount`. */
async function recordCheckoutOrder(
  tx: TestDatabase,
  line: Line,
  paymentStatus: OrderPaymentStatus,
  refundedAmount = 0,
  values: Partial<typeof orders.$inferInsert> = {},
): Promise<string> {
  const paidAt = new Date("2031-03-10T05:05:00Z");
  const orderId = await recordOrder(tx, [line], { ...checkoutOrderValues(), status: "to_ship", paymentStatus, paidAt, ...values });
  const [order] = await tx.select({ totalAmount: orders.totalAmount }).from(orders).where(eq(orders.id, orderId));
  await tx.insert(payments).values({
    orderId,
    provider: "midtrans",
    providerOrderId: `TEST-${randomUUID()}`,
    attempt: 1,
    grossAmount: order!.totalAmount,
    status: paymentStatus === "paid" ? "paid" : paymentStatus,
    paidAt,
    refundedAmount,
  });
  return orderId;
}

describe("getPeriodTotals", () => {
  test("counts Siap Kirim, Dikirim and Selesai; omzet is after voucher and partial refund, without ongkir", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const sku = variant.sku;

      // Counted.
      await recordOrder(tx, [{ sku, qty: 1, unitPrice: 259_000, unitCost: 100_000 }], { status: "to_ship", shippingAmount: 10_000 });
      await recordOrder(
        tx,
        [
          { sku, qty: 2, unitPrice: 249_000, unitCost: 90_000 },
          // Stock valued at 0: flagged, never guessed.
          { sku: (await insertProductVariant(tx)).variant.sku, qty: 1, unitPrice: 100_000, unitCost: 0 },
        ],
        { status: "shipped", channelId: "whatsapp", channelOrderNo: null, shippingAmount: 15_000, discountAmount: 50_000 },
      );
      await recordOrder(tx, [{ sku, qty: 1, unitPrice: 200_000, unitCost: 80_000 }], { status: "completed", channelId: "tiktok" });
      await recordCheckoutOrder(tx, { sku, qty: 1, unitPrice: 259_000, unitCost: 100_000 }, "partially_refunded", 59_000);
      // Not counted.
      await recordOrder(tx, [{ sku, qty: 1, unitPrice: 259_000, unitCost: 0 }], { status: "awaiting_payment" });
      await recordOrder(tx, [{ sku, qty: 1, unitPrice: 259_000, unitCost: 0 }], { status: "cancelled" });
      await recordOrder(tx, [{ sku, qty: 1, unitPrice: 259_000, unitCost: 100_000 }], { status: "returned" });
      await recordCheckoutOrder(tx, { sku, qty: 1, unitPrice: 259_000, unitCost: 100_000 }, "refunded", 0);
      await recordCheckoutOrder(tx, { sku, qty: 1, unitPrice: 259_000, unitCost: 100_000 }, "chargeback", 0);
      await recordOrder(tx, [{ sku, qty: 1, unitPrice: 259_000, unitCost: 100_000 }], { status: "to_ship", orderDate: DAY.end });

      const totals = await getPeriodTotals(DAY, { canViewProfit: true }, tx);
      expect(totals).toEqual({
        orders: 4,
        pcs: 6,
        cancelledOrders: 1,
        returnedOrders: 1,
        money: {
          omzet: 259_000 + (598_000 - 50_000) + 200_000 + (259_000 - 59_000), // 1_207_000
          hpp: 100_000 + 180_000 + 80_000 + 100_000,
          labaKotor: 747_000,
          marginBps: 6189, // 747_000 / 1_207_000 = 61.89%
          averageOrderAmount: 301_750,
          linesWithoutCost: 1,
          // The Shopee (fixture default) and TikTok orders have no fee rows: 0, counted as missing.
          platformFee: 0,
          labaSetelahBiayaPlatform: 747_000,
          platformFees: {
            marketplaceOrders: 2,
            ordersWithoutFees: 2,
            byChannel: [
              { channelId: "shopee", channelName: "Shopee", orders: 1, ordersWithoutFees: 1, platformFee: 0 },
              { channelId: "tiktok", channelName: "TikTok Shop", orders: 1, ordersWithoutFees: 1, platformFee: 0 },
            ],
          },
          // Only the counted checkout order's subsidy (Rp 12.000 quote, fully covered); the refunded
          // and chargeback ones are out with their omzet (docs/plans/growth.md §4.1).
          webShippingSubsidy: 12_000,
        },
      });

      // Without finance.view_profit the money is never computed into the result.
      expect(await getPeriodTotals(DAY, { canViewProfit: false }, tx)).toEqual({ ...totals, money: null });
    });
  });

  test("omzet per order never goes below zero (partial refund, discount over ongkir), and an empty period is all zeros", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      expect(await getPeriodTotals(DAY, { canViewProfit: true }, tx)).toEqual({
        orders: 0,
        pcs: 0,
        cancelledOrders: 0,
        returnedOrders: 0,
        money: {
          omzet: 0,
          hpp: 0,
          labaKotor: 0,
          marginBps: null,
          averageOrderAmount: null,
          linesWithoutCost: 0,
          platformFee: 0,
          labaSetelahBiayaPlatform: 0,
          platformFees: { marketplaceOrders: 0, ordersWithoutFees: 0, byChannel: [] },
          webShippingSubsidy: 0,
        },
      });
      // A refund that also covered the buyer's Rp 10.000 ongkir share: the goods amount is the floor.
      await recordCheckoutOrder(tx, { sku: variant.sku, qty: 1, unitPrice: 100_000, unitCost: 40_000 }, "partially_refunded", 110_000, shippingQuoteValues(30_000, 20_000));
      // A manual order whose discount also covered its ongkir (only the total must stay >= 0).
      await recordOrder(tx, [{ sku: variant.sku, qty: 1, unitPrice: 20_000, unitCost: 5_000 }], {
        status: "to_ship",
        shippingAmount: 15_000,
        discountAmount: 30_000,
      });
      const totals = await getPeriodTotals(DAY, { canViewProfit: true }, tx);
      // The partially refunded checkout order still counts, and so does its Rp 20.000 subsidy
      // (docs/plans/growth.md §4.1); it never touches laba kotor.
      expect(totals.money).toMatchObject({ omzet: 0, hpp: 45_000, labaKotor: -45_000, marginBps: null, webShippingSubsidy: 20_000 });
    });
  });

  test("the Jakarta day decides: 23:30 WIB is that day, 00:30 WIB the next", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const line = { sku: variant.sku, qty: 1, unitPrice: 100_000, unitCost: 0 };
      await recordOrder(tx, [line], { status: "to_ship", orderDate: new Date("2031-03-10T16:30:00Z") });
      await recordOrder(tx, [line], { status: "to_ship", orderDate: new Date("2031-03-10T17:30:00Z") });
      await recordOrder(tx, [line], { status: "to_ship", orderDate: new Date("2031-03-09T16:59:59Z") });
      expect((await getPeriodTotals(DAY, { canViewProfit: false }, tx)).orders).toBe(1);
    });
  });

  test("a later return removes the order from its original date", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const orderId = await recordOrder(tx, [{ sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 100_000 }], { status: "completed" });
      expect((await getPeriodTotals(DAY, { canViewProfit: true }, tx)).money?.omzet).toBe(259_000);
      await tx.update(orders).set({ status: "returned", returnedAt: new Date() }).where(eq(orders.id, orderId));
      const after = await getPeriodTotals(DAY, { canViewProfit: true }, tx);
      expect(after).toMatchObject({ orders: 0, returnedOrders: 1, money: { omzet: 0 } });
    });
  });
});

describe("platform fees (docs/plans/marketplace-import.md §9, tests 45 and 46)", () => {
  async function fees(tx: TestDatabase, orderId: string, amounts: Partial<Record<ChannelFeeComponent, number>>) {
    for (const [component, amount] of Object.entries(amounts)) await tx.insert(orderChannelFees).values({ orderId, component: component as ChannelFeeComponent, amount: amount! });
  }

  test("fees once per order, only counted orders, missing only for marketplace orders without fee rows", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const other = (await insertProductVariant(tx)).variant.sku;
      const sku = variant.sku;

      // Shopee, two lines, two fee rows: Rp 7.500 once (a join per line would double it).
      const twoLines = await recordOrder(
        tx,
        [
          { sku, qty: 1, unitPrice: 250_000, unitCost: 100_000 },
          { sku: other, qty: 2, unitPrice: 100_000, unitCost: 40_000 },
        ],
        { status: "completed", channelId: "shopee" },
      );
      await fees(tx, twoLines, { admin_fee: 4_500, service_fee: 3_000 });
      // TikTok with a known zero fee: not missing.
      const knownZero = await recordOrder(tx, [{ sku, qty: 1, unitPrice: 200_000, unitCost: 80_000 }], { status: "shipped", channelId: "tiktok" });
      await fees(tx, knownZero, { platform_commission: 0, seller_shipping_subsidy: 2_000 });
      // Shopee without fee rows (e.g. typed by hand): adds 0, counted as missing.
      await recordOrder(tx, [{ sku, qty: 1, unitPrice: 300_000, unitCost: 120_000 }], { status: "to_ship", channelId: "shopee" });
      // Website and WhatsApp: no platform fee at all, never missing.
      await recordOrder(tx, [{ sku, qty: 1, unitPrice: 150_000, unitCost: 60_000 }], { status: "completed", channelId: "whatsapp", channelOrderNo: null });
      await recordOrder(tx, [{ sku, qty: 1, unitPrice: 150_000, unitCost: 60_000 }], { status: "completed", channelId: "web", channelOrderNo: null });
      // Not counted (omzet definition): their fees and missing state never count either.
      for (const status of ["cancelled", "returned", "awaiting_payment"] as const) {
        const undone = await recordOrder(tx, [{ sku, qty: 1, unitPrice: 999_000, unitCost: 1 }], { status, channelId: "shopee" });
        await fees(tx, undone, { admin_fee: 50_000 });
        await recordOrder(tx, [{ sku, qty: 1, unitPrice: 999_000, unitCost: 1 }], { status, channelId: "tiktok" });
      }
      const refunded = await recordCheckoutOrder(tx, { sku, qty: 1, unitPrice: 999_000, unitCost: 1 }, "refunded", 0);
      await fees(tx, refunded, { other: 9_000 });
      // Outside the day.
      const tomorrow = await recordOrder(tx, [{ sku, qty: 1, unitPrice: 999_000, unitCost: 1 }], { status: "completed", channelId: "shopee", orderDate: DAY.end });
      await fees(tx, tomorrow, { admin_fee: 70_000 });

      const totals = await getPeriodTotals(DAY, { canViewProfit: true }, tx);
      const omzet = 450_000 + 200_000 + 300_000 + 150_000 + 150_000;
      const hpp = 180_000 + 80_000 + 120_000 + 60_000 + 60_000;
      expect(totals.orders).toBe(5);
      expect(totals.money).toMatchObject({ omzet, hpp, labaKotor: omzet - hpp, platformFee: 9_500, labaSetelahBiayaPlatform: omzet - hpp - 9_500 });
      expect(totals.money?.platformFees).toEqual({
        marketplaceOrders: 3,
        ordersWithoutFees: 1,
        byChannel: [
          { channelId: "shopee", channelName: "Shopee", orders: 2, ordersWithoutFees: 1, platformFee: 7_500 },
          { channelId: "tiktok", channelName: "TikTok Shop", orders: 1, ordersWithoutFees: 0, platformFee: 2_000 },
        ],
      });
      // Staff never receive any of it.
      expect((await getPeriodTotals(DAY, { canViewProfit: false }, tx)).money).toBeNull();
    });
  });

  test("a period with only non-marketplace orders has no fee channel and nothing missing", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      await recordOrder(tx, [{ sku: variant.sku, qty: 1, unitPrice: 100_000, unitCost: 40_000 }], { status: "completed", channelId: "instagram", channelOrderNo: null });
      expect((await getPeriodTotals(DAY, { canViewProfit: true }, tx)).money).toMatchObject({
        platformFee: 0,
        labaSetelahBiayaPlatform: 60_000,
        platformFees: { marketplaceOrders: 0, ordersWithoutFees: 0, byChannel: [] },
      });
    });
  });

  test("imported orders count on their order date in omzet, laba kotor, Per kanal and the fees; a cancelled one drops out (test 45)", async () => {
    await withRollback(async (tx) => {
      const marker = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
      // An uppercase SKU, as admin generates them (the importer uppercases the file's).
      const { product, fabric } = await insertProductVariant(tx);
      const color = await insertFabricColor(tx, fabric.id);
      const variant = { sku: `OVW${marker}-M` };
      await tx.insert(productVariants).values({ sku: variant.sku, productId: product.id, fabricId: fabric.id, fabricColorId: color.id, closure: "front_zip", size: "M" });
      await tx.insert(stockMovements).values({ sku: variant.sku, qty: 10, valueAmount: 1_000_000, type: "production", refType: "manual" });
      const staff = await insertStaffUser(tx);
      const commit = async (orders: FixtureOrder[]) => {
        const parsed = parseMarketplaceFile({ channelId: "shopee", fileName: "uji.xlsx", bytes: xlsxBytes(shopeeRows(orders)), assumeMappingVerified: true });
        if (!parsed.ok) throw new Error(parsed.error.message);
        const planned = await planImport(parsed.value, {}, tx);
        if (!planned.ok) throw new Error(planned.error.message);
        const outcome = await commitImport({ parsed: parsed.value, fileName: "uji.xlsx", options: {}, expectedDigest: planned.value.digest, actorStaffUserId: staff.id }, tx);
        if (outcome.kind !== "committed") throw new Error(outcome.kind);
      };
      // 2031-03-10 12:00 WIB, as Waktu Pesanan Dibuat.
      const lines = [{ sku: variant.sku, qty: 1, lineTotal: 249_000 }];
      await commit([
        { orderNo: `${marker}A`, status: "Selesai", orderedAt: "2031-03-10 12:00", sellerVoucher: 9_000, adminFee: 4_000, serviceFee: 1_000, lines },
        { orderNo: `${marker}B`, status: "Perlu Dikirim", orderedAt: "2031-03-10 13:00", adminFee: 4_000, lines },
      ]);
      const before = await getPeriodTotals(DAY, { canViewProfit: true }, tx);
      expect(before.orders).toBe(2);
      expect(before.money).toMatchObject({ omzet: 240_000 + 249_000, hpp: 200_000, platformFee: 9_000, labaSetelahBiayaPlatform: 489_000 - 200_000 - 9_000 });
      expect(before.money?.platformFees.ordersWithoutFees).toBe(0);
      expect(await getChannelBreakdown(DAY, { canViewProfit: true }, tx)).toEqual([{ channelId: "shopee", channelName: "Shopee", orders: 2, pcs: 2, omzet: 489_000 }]);

      // B is cancelled on Shopee: cancelled in admin, out of every figure, its fees with it.
      await commit([{ orderNo: `${marker}B`, status: "Batal", orderedAt: "2031-03-10 13:00", adminFee: 4_000, lines }]);
      const after = await getPeriodTotals(DAY, { canViewProfit: true }, tx);
      expect(after).toMatchObject({ orders: 1, cancelledOrders: 1 });
      expect(after.money).toMatchObject({ omzet: 240_000, hpp: 100_000, platformFee: 5_000, labaSetelahBiayaPlatform: 135_000 });
    });
  });
});

describe("breakdowns", () => {
  test("per channel and per product type both add up exactly to the omzet tile", async () => {
    await withRollback(async (tx) => {
      const { fabric, color, variant: dress } = await insertProductVariant(tx);
      await tx.insert(productTypes).values({ code: "KHIMAR_TEST", name: `Khimar ${randomUUID().slice(0, 8)}`, sortOrder: 9 });
      const { variant: khimar } = await insertVariantForProduct(tx, fabric.id, color.id, { productTypeCode: "KHIMAR_TEST" });
      const dress2 = (await insertVariantForProduct(tx, fabric.id, color.id)).variant;

      // Rp 10.000 voucher over three equal lines: 290.000 does not split into thirds.
      await recordOrder(
        tx,
        [
          { sku: khimar.sku, qty: 1, unitPrice: 100_000, unitCost: 30_000 },
          { sku: dress.sku, qty: 1, unitPrice: 100_000, unitCost: 30_000 },
          { sku: dress2.sku, qty: 1, unitPrice: 100_000, unitCost: 30_000 },
        ],
        { status: "to_ship", discountAmount: 10_000 },
      );
      await recordOrder(tx, [{ sku: dress.sku, qty: 2, unitPrice: 259_000, unitCost: 100_000 }], {
        status: "shipped",
        channelId: "whatsapp",
        channelOrderNo: null,
      });
      await recordCheckoutOrder(tx, { sku: khimar.sku, qty: 1, unitPrice: 150_000, unitCost: 50_000 }, "partially_refunded", 50_000);

      const omzet = (await getPeriodTotals(DAY, { canViewProfit: true }, tx)).money!.omzet;
      expect(omzet).toBe(290_000 + 518_000 + 100_000);

      const channels = await getChannelBreakdown(DAY, { canViewProfit: true }, tx);
      expect(channels).toEqual([
        { channelId: "whatsapp", channelName: expect.any(String), orders: 1, pcs: 2, omzet: 518_000 },
        { channelId: "shopee", channelName: expect.any(String), orders: 1, pcs: 3, omzet: 290_000 },
        { channelId: "web", channelName: expect.any(String), orders: 1, pcs: 1, omzet: 100_000 },
      ]);

      const types = await getProductTypeBreakdown(DAY, { canViewProfit: true }, tx);
      expect(types.map((row) => row.productTypeCode)).toEqual(["DRESS", "KHIMAR_TEST"]);
      expect(types.reduce((sum, row) => sum + row.omzet!, 0)).toBe(omzet);
      const khimarRow = types.find((row) => row.productTypeCode === "KHIMAR_TEST")!;
      expect(khimarRow.pcs).toBe(2);
      // Its third of 290.000 (96.666 or, as the remainder line, 96.668) plus the refunded web order.
      expect([96_666 + 100_000, 96_668 + 100_000]).toContain(khimarRow.omzet);

      // Counts only without finance.view_profit, in a count order.
      expect(await getChannelBreakdown(DAY, { canViewProfit: false }, tx)).toEqual([
        { channelId: "shopee", channelName: expect.any(String), orders: 1, pcs: 3, omzet: null },
        { channelId: "web", channelName: expect.any(String), orders: 1, pcs: 1, omzet: null },
        { channelId: "whatsapp", channelName: expect.any(String), orders: 1, pcs: 2, omzet: null },
      ]);
      expect(await getProductTypeBreakdown(DAY, { canViewProfit: false }, tx)).toEqual([
        { productTypeCode: "DRESS", productTypeName: "Gamis", pcs: 4, omzet: null },
        { productTypeCode: "KHIMAR_TEST", productTypeName: expect.any(String), pcs: 2, omzet: null },
      ]);
    });
  });
});

describe("sales goal", () => {
  test("migration 0039's row is read back", async () => {
    await withRollback(async (tx) => {
      expect(await getSalesGoal(tx)).toEqual({ revenueTargetAmount: 1_000_000_000, startDate: "2026-11-01" });
    });
  });

  test("progress counts omzet from the start date up to now, and is withheld without finance.view_profit", async () => {
    await withRollback(async (tx) => {
      await tx.update(salesGoal).set({ revenueTargetAmount: 366_000_000, startDate: "2031-03-01" }); // 366 days, to 29 Feb 2032
      const { variant } = await insertProductVariant(tx);
      const line = { sku: variant.sku, qty: 1, unitPrice: 300_000, unitCost: 100_000 };
      await recordOrder(tx, [line], { status: "completed", orderDate: new Date("2031-02-28T16:59:00Z") }); // 23:59 WIB, before the start
      await recordOrder(tx, [line], { status: "completed", orderDate: new Date("2031-03-01T00:00:00Z") });
      await recordOrder(tx, [line], { status: "to_ship", orderDate: IN_DAY });
      await recordOrder(tx, [line], { status: "to_ship", orderDate: new Date("2031-03-10T06:00:00Z") }); // after "now"

      const now = new Date("2031-03-10T05:30:00Z");
      expect(await getGoalProgress({ canViewProfit: false, now }, tx)).toBeNull();
      const progress = await getGoalProgress({ canViewProfit: true, now }, tx);
      expect(progress).toMatchObject({
        state: "active",
        actualAmount: 600_000,
        elapsedDays: 10,
        expectedAmount: 10_000_000,
        status: "behind",
        neededPcsPerDay: null, // 3 pcs in the last 30 days: no average price yet
      });
    });
  });
});

describe("getSalesSeries", () => {
  const MONTH = { start: jakartaMidnight("2031-03-01"), end: jakartaMidnight("2031-05-01") };

  test("buckets by Jakarta day: 23:30 WIB stays on its day, 00:30 WIB is the next", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const line = { sku: variant.sku, qty: 2, unitPrice: 100_000, unitCost: 40_000 };
      await recordOrder(tx, [line], { status: "to_ship", orderDate: new Date("2031-03-10T16:30:00Z") }); // 23:30 WIB 10 Mar
      await recordOrder(tx, [line], { status: "completed", orderDate: new Date("2031-03-10T17:30:00Z") }); // 00:30 WIB 11 Mar
      await recordOrder(tx, [line], { status: "shipped", orderDate: new Date("2031-03-11T05:00:00Z"), discountAmount: 20_000, shippingAmount: 15_000 });
      await recordOrder(tx, [line], { status: "cancelled", orderDate: new Date("2031-03-11T05:00:00Z") });

      expect(await getSalesSeries(MONTH, { canViewProfit: true, granularity: "day" }, tx)).toEqual([
        { key: "2031-03-10", orders: 1, pcs: 2, omzet: 200_000 },
        { key: "2031-03-11", orders: 2, pcs: 4, omzet: 380_000 },
      ]);
      // Without finance.view_profit: counts only, no amount selected.
      expect(await getSalesSeries(MONTH, { canViewProfit: false, granularity: "day" }, tx)).toEqual([
        { key: "2031-03-10", orders: 1, pcs: 2, omzet: null },
        { key: "2031-03-11", orders: 2, pcs: 4, omzet: null },
      ]);
    });
  });

  test("monthly buckets are Jakarta months and sum to the period omzet", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const line = { sku: variant.sku, qty: 1, unitPrice: 100_000, unitCost: 40_000 };
      await recordOrder(tx, [line], { status: "to_ship", orderDate: new Date("2031-03-31T17:30:00Z") }); // 1 Apr 00:30 WIB
      await recordOrder(tx, [line], { status: "to_ship", orderDate: new Date("2031-03-31T16:00:00Z") }); // 31 Mar 23:00 WIB
      await recordOrder(tx, [line], { status: "to_ship", orderDate: new Date("2031-03-05T05:00:00Z") });

      const months = await getSalesSeries(MONTH, { canViewProfit: true, granularity: "month" }, tx);
      expect(months).toEqual([
        { key: "2031-03-01", orders: 2, pcs: 2, omzet: 200_000 },
        { key: "2031-04-01", orders: 1, pcs: 1, omzet: 100_000 },
      ]);
      const totals = await getPeriodTotals(MONTH, { canViewProfit: true }, tx);
      expect(months.reduce((sum, point) => sum + point.omzet!, 0)).toBe(totals.money!.omzet);
    });
  });
});

describe("getTopProducts", () => {
  test("by pcs with each product's variants; omzet is allocated (D6) and adds up to the tile", async () => {
    await withRollback(async (tx) => {
      const { fabric, color, product: gamis, variant: gamisM } = await insertProductVariant(tx);
      const [gamisL] = await tx
        .insert(productVariants)
        .values({ sku: `SKU-${randomUUID()}`, productId: gamis.id, fabricId: fabric.id, fabricColorId: color.id, closure: gamis.closure, size: "L" })
        .returning();
      const { product: khimar, variant: khimarM } = await insertVariantForProduct(tx, fabric.id, color.id, { name: "Khimar Test" });

      // Gamis: 3 pcs (2 M, 1 L); Khimar: 2 pcs but more omzet. Rp 10.000 voucher spread over the first order.
      await recordOrder(
        tx,
        [
          { sku: gamisM.sku, qty: 2, unitPrice: 100_000, unitCost: 40_000 },
          { sku: khimarM.sku, qty: 1, unitPrice: 300_000, unitCost: 100_000 },
        ],
        { status: "to_ship", discountAmount: 10_000 },
      );
      await recordOrder(tx, [{ sku: gamisL!.sku, qty: 1, unitPrice: 100_000, unitCost: 40_000 }], { status: "completed" });
      await recordOrder(tx, [{ sku: khimarM.sku, qty: 1, unitPrice: 300_000, unitCost: 100_000 }], { status: "shipped" });
      await recordOrder(tx, [{ sku: gamisM.sku, qty: 5, unitPrice: 100_000, unitCost: 40_000 }], { status: "cancelled" });

      const byPcs = await getTopProducts(DAY, { canViewProfit: true }, tx);
      expect(byPcs.map((row) => [row.productId, row.pcs])).toEqual([
        [gamis.id, 3],
        [khimar.id, 2],
      ]);
      expect(byPcs[0]!.variants.map((variant) => [variant.sku, variant.size, variant.pcs])).toEqual([
        [gamisM.sku, "M", 2],
        [gamisL!.sku, "L", 1],
      ]);
      expect(byPcs[0]!.moreVariants).toBe(0);
      for (const row of byPcs) expect(row.variants.reduce((sum, variant) => sum + variant.omzet!, 0)).toBe(row.omzet);
      const omzet = (await getPeriodTotals(DAY, { canViewProfit: true }, tx)).money!.omzet;
      expect(byPcs.reduce((sum, row) => sum + row.omzet!, 0)).toBe(omzet);

      const byOmzet = await getTopProducts(DAY, { canViewProfit: true, rank: "omzet" }, tx);
      expect(byOmzet.map((row) => row.productId)).toEqual([khimar.id, gamis.id]);

      // Without finance.view_profit: pcs only, and a rank by omzet is ignored.
      const withoutFinance = await getTopProducts(DAY, { canViewProfit: false, rank: "omzet" }, tx);
      expect(withoutFinance.map((row) => [row.productId, row.pcs, row.omzet])).toEqual([
        [gamis.id, 3, null],
        [khimar.id, 2, null],
      ]);
      expect(withoutFinance.flatMap((row) => row.variants).every((variant) => variant.omzet === null)).toBe(true);
    });
  });
});

describe("getGoalCumulative", () => {
  test("cumulative monthly omzet from the start, null without finance or before the start", async () => {
    await withRollback(async (tx) => {
      await tx.update(salesGoal).set({ revenueTargetAmount: 365_000_000, startDate: "2031-02-15" });
      const { variant } = await insertProductVariant(tx);
      const line = { sku: variant.sku, qty: 1, unitPrice: 300_000, unitCost: 100_000 };
      await recordOrder(tx, [line], { status: "completed", orderDate: new Date("2031-02-14T05:00:00Z") }); // before the start
      await recordOrder(tx, [line], { status: "completed", orderDate: new Date("2031-02-20T05:00:00Z") });
      await recordOrder(tx, [line], { status: "to_ship", orderDate: IN_DAY });

      const now = new Date("2031-03-10T06:00:00Z");
      expect(await getGoalCumulative({ canViewProfit: false, now }, tx)).toBeNull();
      expect(await getGoalCumulative({ canViewProfit: true, now: new Date("2031-02-14T05:00:00Z") }, tx)).toBeNull();
      const series = (await getGoalCumulative({ canViewProfit: true, now }, tx))!;
      expect(series).toHaveLength(13);
      expect(series.slice(0, 3)).toEqual([
        { month: "2031-02-01", expected: 14_000_000, actual: 300_000 },
        { month: "2031-03-01", expected: 45_000_000, actual: 600_000 },
        { month: "2031-04-01", expected: 75_000_000, actual: null },
      ]);
    });
  });
});
