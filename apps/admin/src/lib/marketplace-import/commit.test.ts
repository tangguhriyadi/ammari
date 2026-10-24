import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { insertFabricColor, insertOrder, insertProductVariant, insertStaffUser, insertThankYouCard } from "@ammari/db/test-fixtures";
import {
  auditLog,
  fabricColors,
  fabrics,
  importBatches,
  importBatchOrders,
  orderChannelFees,
  orderItems,
  orders,
  products,
  productVariants,
  stockMovements,
  thankYouCards,
  type OrderStatus,
} from "@ammari/db/schema";
import { commitMarketplaceImport } from "@ammari/commerce/marketplace-import";
import { SHOPEE_HEADER, shopeeRows, xlsxBytes, type FixtureCell, type FixtureOrder } from "../../../test/marketplace-fixtures";
import { SHOPEE_MAPPING_VERIFIED } from "./adapters/shopee";
import { commitImport, toCommitPlan, type CommitOutcome } from "./commit";
import { parseMarketplaceFile, type ParsedImport } from "./parse-file";
import { planImport, type ImportPlan, type PlanOptions } from "./plan";

// Commit (docs/plans/marketplace-import.md §6, §7, session 4, tests 33 to 43). TDD for the stock
// path. Synthetic fixtures only; every test runs inside withRollback against ammari_test, except the
// concurrency test, which needs real commits on separate connections and cleans up after itself.
// The Shopee mapping stays locked in code (SHOPEE_MAPPING_VERIFIED = false): these tests parse with
// the e2e/test-only `assumeMappingVerified`, and test 43 asserts the lock without it.

interface Seeded {
  sku: (suffix: string) => string;
  orderNo: (suffix: string) => string;
  cleanup: { productId: string; fabricId: string; colorIds: string[]; skus: string[] };
}

async function seedVariants(tx: TestDatabase, suffixes: readonly string[], stock: Readonly<Record<string, number>> = {}): Promise<Seeded> {
  const marker = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const { product, fabric, color: baseColor, variant: baseVariant } = await insertProductVariant(tx);
  const sku = (suffix: string) => `CMT${marker}-${suffix}`;
  const colorIds = [baseColor.id];
  for (const suffix of suffixes) {
    const color = await insertFabricColor(tx, fabric.id);
    colorIds.push(color.id);
    await tx.insert(productVariants).values({ sku: sku(suffix), productId: product.id, fabricId: fabric.id, fabricColorId: color.id, closure: "front_zip", size: "M" });
    const qty = stock[suffix] ?? 10;
    // Rp100.000 per piece, so every sale's value and locked unit_cost is easy to assert.
    if (qty > 0) await tx.insert(stockMovements).values({ sku: sku(suffix), qty, valueAmount: qty * 100_000, type: "production", refType: "manual" });
  }
  return {
    sku,
    orderNo: (suffix: string) => `${marker}${suffix}`,
    cleanup: { productId: product.id, fabricId: fabric.id, colorIds, skus: [baseVariant.sku, ...suffixes.map(sku)] },
  };
}

function parseRows(rows: FixtureCell[][], options: { locked?: boolean } = {}): ParsedImport {
  const result = parseMarketplaceFile({ channelId: "shopee", fileName: "pesanan.xlsx", bytes: xlsxBytes(rows), assumeMappingVerified: !options.locked });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const parse = (orders: readonly FixtureOrder[], options: { locked?: boolean } = {}) => parseRows(shopeeRows(orders), options);

async function plan(db: TestDatabase, parsed: ParsedImport, options: PlanOptions = {}): Promise<ImportPlan> {
  const result = await planImport(parsed, options, db);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Periksa file, then Simpan with the digest just shown (the normal two-step flow). */
async function previewAndCommit(db: TestDatabase, parsed: ParsedImport, actorStaffUserId: string, options: PlanOptions = {}): Promise<CommitOutcome> {
  const preview = await plan(db, parsed, options);
  return commitImport({ parsed, fileName: "pesanan.xlsx", options, expectedDigest: preview.digest, actorStaffUserId }, db);
}

function committed(outcome: CommitOutcome): Extract<CommitOutcome, { kind: "committed" }> {
  if (outcome.kind !== "committed") throw new Error(`expected a commit, got ${outcome.kind}`);
  return outcome;
}

async function orderByChannelNo(db: TestDatabase, channelOrderNo: string) {
  const [order] = await db.select().from(orders).where(and(eq(orders.channelId, "shopee"), eq(orders.channelOrderNo, channelOrderNo)));
  return order;
}

async function movementsFor(db: TestDatabase, skus: readonly string[]) {
  return db.select().from(stockMovements).where(inArray(stockMovements.sku, [...skus]));
}

/** Drops one column (header and cells) from fixture rows: an export without that column. */
function withoutColumn(rows: FixtureCell[][], header: (typeof SHOPEE_HEADER)[number]): FixtureCell[][] {
  const index = rows[0]!.indexOf(header);
  return rows.map((row) => row.filter((_, column) => column !== index));
}

async function tableCounts(db: TestDatabase) {
  const count = async (table: typeof orders | typeof orderItems | typeof stockMovements | typeof orderChannelFees | typeof importBatches | typeof importBatchOrders | typeof auditLog) => {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
    return row?.n ?? 0;
  };
  return {
    orders: await count(orders),
    orderItems: await count(orderItems),
    stockMovements: await count(stockMovements),
    fees: await count(orderChannelFees),
    batches: await count(importBatches),
    batchOrders: await count(importBatchOrders),
    audit: await count(auditLog),
  };
}

describe("commitImport: a new Selesai order (test 33)", () => {
  test("one order, its lines, one sale per line at the locked cost, completed, with batch, history and audit rows", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M", "L"]);
      const staff = await insertStaffUser(tx);
      const parsed = parse([
        {
          orderNo: s.orderNo("A"),
          status: "Selesai",
          orderedAt: "2026-10-22 09:15",
          sellerVoucher: 10_000,
          adminFee: 4_500,
          serviceFee: 3_000,
          lines: [
            { sku: s.sku("M"), qty: 1, lineTotal: 249_000 },
            { sku: s.sku("L"), qty: 2, lineTotal: 518_000 },
          ],
        },
      ]);

      const outcome = committed(await previewAndCommit(tx, parsed, staff.id));
      expect(outcome).toMatchObject({ created: 1, updated: 0, reviewCount: 0 });
      expect(outcome.stockSkus).toEqual([s.sku("L"), s.sku("M")]);

      const order = await orderByChannelNo(tx, s.orderNo("A"));
      expect(order).toMatchObject({
        status: "completed",
        subtotalAmount: 767_000,
        discountAmount: 10_000,
        shippingAmount: 0,
        totalAmount: 757_000,
        importBatchId: outcome.batchId,
        createdByStaffUserId: null,
        buyerUsername: null,
        shippingAddress: null,
        customerId: null,
        channelStatus: "Selesai",
        needsAttention: [],
      });
      expect(order!.orderNo).toMatch(/^ORD-\d{6}-\d{4}$/);
      // Waktu Pesanan Dibuat, Asia/Jakarta, as the real instant (decision 13).
      expect(order!.orderDate.toISOString()).toBe("2026-10-22T02:15:00.000Z");
      expect(order!.shippedAt).not.toBeNull();
      expect(order!.completedAt).not.toBeNull();
      expect(order!.channelSyncedAt).not.toBeNull();

      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order!.id));
      expect(items.map((item) => [item.sku, item.qty, item.unitPrice, item.unitCost, item.listUnitPrice]).sort()).toEqual(
        [
          [s.sku("L"), 2, 259_000, 100_000, null],
          [s.sku("M"), 1, 249_000, 100_000, null],
        ].sort(),
      );

      const sales = (await movementsFor(tx, [s.sku("M"), s.sku("L")])).filter((movement) => movement.type === "sale");
      expect(sales.map((sale) => [sale.sku, sale.qty, sale.valueAmount, sale.createdByStaffUserId]).sort()).toEqual(
        [
          [s.sku("L"), -2, -200_000, staff.id],
          [s.sku("M"), -1, -100_000, staff.id],
        ].sort(),
      );

      const fees = await tx.select().from(orderChannelFees).where(eq(orderChannelFees.orderId, order!.id));
      expect(Object.fromEntries(fees.map((fee) => [fee.component, fee.amount]))).toEqual({ admin_fee: 4_500, service_fee: 3_000, affiliate_commission: 0 });
      expect(fees.every((fee) => fee.importBatchId === outcome.batchId)).toBe(true);

      const [batch] = await tx.select().from(importBatches).where(eq(importBatches.id, outcome.batchId));
      expect(batch).toMatchObject({ channelId: "shopee", kind: "orders", status: "committed", uploadedBy: staff.id, filename: "pesanan.xlsx", fileSha256: parsed.fileSha256, rowCount: 2 });
      expect(batch!.committedAt).not.toBeNull();
      expect(batch!.summary).toMatchObject({ counts: { create: 1, update: 0, unchanged: 0, review: 0, skip: 0 }, totals: { newOrderCount: 1, newPieces: 3, newOmzetAmount: 757_000 } });

      const history = await tx.select().from(importBatchOrders).where(eq(importBatchOrders.importBatchId, outcome.batchId));
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ orderId: order!.id, action: "created", changes: { status: "completed", rawStatus: "Selesai" } });

      const audits = await tx.select({ action: auditLog.action, entityType: auditLog.entityType, entityId: auditLog.entityId, actor: auditLog.actorStaffUserId }).from(auditLog).where(inArray(auditLog.entityId, [order!.id, outcome.batchId]));
      expect(audits.map((row) => row.action).sort()).toEqual(["import_commit", "import_create", "transition_status", "transition_status"]);
      expect(audits.every((row) => row.actor === staff.id)).toBe(true);
    });
  });

  test("Perlu Dikirim creates a to_ship order (Packing, Siap Kirim) with stock already out", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      committed(await previewAndCommit(tx, parse([{ orderNo: s.orderNo("A"), status: "Perlu Dikirim", lines: [{ sku: s.sku("M"), qty: 3, lineTotal: 747_000 }] }]), staff.id));
      const order = await orderByChannelNo(tx, s.orderNo("A"));
      expect(order).toMatchObject({ status: "to_ship", shippedAt: null });
      const total = (await movementsFor(tx, [s.sku("M")])).reduce((sum, movement) => sum + movement.qty, 0);
      expect(total).toBe(7);
    });
  });
});

describe("commitImport: idempotent re-import (test 34)", () => {
  test("the same file twice: the second is all unchanged and writes nothing", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const parsed = parse([
        { orderNo: s.orderNo("A"), status: "Selesai", adminFee: 1_000, lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
        { orderNo: s.orderNo("B"), status: "Perlu Dikirim", lines: [{ sku: s.sku("M"), qty: 2, lineTotal: 498_000 }] },
      ]);
      committed(await previewAndCommit(tx, parsed, staff.id));
      const before = await tableCounts(tx);

      const again = await plan(tx, parsed);
      expect(again.counts).toEqual({ create: 0, update: 0, unchanged: 2, review: 0, skip: 0 });
      expect(again.previousCommit).not.toBeNull();
      const outcome = await commitImport({ parsed, fileName: "pesanan.xlsx", options: {}, expectedDigest: again.digest, actorStaffUserId: staff.id }, tx);
      expect(outcome.kind).toBe("nothing_to_save");
      expect(await tableCounts(tx)).toEqual(before);
    });
  });
});

describe("commitImport: status changes on existing orders (tests 35 to 37)", () => {
  test("to_ship -> Batal: cancelled, one return per line at the sale's exact negation, the active card voided", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M", "L"]);
      const staff = await insertStaffUser(tx);
      const lines = [
        { sku: s.sku("M"), qty: 1, lineTotal: 249_000 },
        { sku: s.sku("L"), qty: 2, lineTotal: 518_000 },
      ];
      committed(await previewAndCommit(tx, parse([{ orderNo: s.orderNo("A"), status: "Perlu Dikirim", lines }]), staff.id));
      const order = await orderByChannelNo(tx, s.orderNo("A"));
      const card = await insertThankYouCard(tx, order!.id);

      const outcome = committed(await previewAndCommit(tx, parse([{ orderNo: s.orderNo("A"), status: "Batal", lines }]), staff.id));
      expect(outcome).toMatchObject({ created: 0, updated: 1 });

      const after = await orderByChannelNo(tx, s.orderNo("A"));
      expect(after).toMatchObject({ status: "cancelled", channelStatus: "Batal" });
      const movements = await movementsFor(tx, [s.sku("M"), s.sku("L")]);
      const returns = movements.filter((movement) => movement.type === "return");
      expect(returns).toHaveLength(2);
      for (const sale of movements.filter((movement) => movement.type === "sale")) {
        const back = returns.find((movement) => movement.refId === sale.refId);
        expect(back).toMatchObject({ qty: -sale.qty, valueAmount: -sale.valueAmount });
      }
      expect(movements.filter((movement) => movement.sku === s.sku("L")).reduce((sum, movement) => sum + movement.qty, 0)).toBe(10);
      const [voided] = await tx.select().from(thankYouCards).where(eq(thankYouCards.id, card.id));
      expect(voided?.status).toBe("void");

      const [history] = await tx.select().from(importBatchOrders).where(eq(importBatchOrders.importBatchId, outcome.batchId));
      expect(history).toMatchObject({ action: "updated", changes: { status: { before: "to_ship", after: "cancelled" } } });
      const [update] = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, order!.id), eq(auditLog.action, "import_update")));
      expect(update).toBeDefined();
    });
  });

  test("shipped -> Batal: returned (the lifecycle forbids shipped -> cancelled), stock restored", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const lines = [{ sku: s.sku("M"), qty: 2, lineTotal: 498_000 }];
      committed(await previewAndCommit(tx, parse([{ orderNo: s.orderNo("A"), status: "Dikirim", lines }]), staff.id));
      expect((await orderByChannelNo(tx, s.orderNo("A")))?.status).toBe("shipped");

      committed(await previewAndCommit(tx, parse([{ orderNo: s.orderNo("A"), status: "Batal", lines }]), staff.id));
      const after = await orderByChannelNo(tx, s.orderNo("A"));
      expect(after?.status).toBe("returned");
      expect(after?.returnedAt).not.toBeNull();
      expect((await movementsFor(tx, [s.sku("M")])).reduce((sum, movement) => sum + movement.qty, 0)).toBe(10);
    });
  });

  test("Dalam Pengembalian: new order shipped with the flag and no return movement; a later Batal returns it and clears the flag", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const lines = [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }];
      committed(await previewAndCommit(tx, parse([{ orderNo: s.orderNo("A"), status: "Dalam Pengembalian", lines }]), staff.id));
      const pending = await orderByChannelNo(tx, s.orderNo("A"));
      expect(pending).toMatchObject({ status: "shipped", needsAttention: ["marketplace_return_pending"] });
      expect((await movementsFor(tx, [s.sku("M")])).filter((movement) => movement.type === "return")).toHaveLength(0);

      // An older overlapping file still saying Dikirim keeps the flag (rule 3a).
      const older = await plan(tx, parse([{ orderNo: s.orderNo("A"), status: "Dikirim", lines }]));
      expect(older.entries[0]).toMatchObject({ action: "update", transitions: [], clearReturnPending: false });

      committed(await previewAndCommit(tx, parse([{ orderNo: s.orderNo("A"), status: "Batal", lines }]), staff.id));
      const done = await orderByChannelNo(tx, s.orderNo("A"));
      expect(done).toMatchObject({ status: "returned", needsAttention: [] });
      expect((await movementsFor(tx, [s.sku("M")])).filter((movement) => movement.type === "return")).toHaveLength(1);
    });
  });

  test("Dalam Pengembalian on an admin order still to_ship: moved to shipped AND flagged (owner, session 4)", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const lines = [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }];
      committed(await previewAndCommit(tx, parse([{ orderNo: s.orderNo("A"), status: "Perlu Dikirim", lines }]), staff.id));
      committed(await previewAndCommit(tx, parse([{ orderNo: s.orderNo("A"), status: "Dalam Pengembalian", lines }]), staff.id));
      const order = await orderByChannelNo(tx, s.orderNo("A"));
      expect(order).toMatchObject({ status: "shipped", needsAttention: ["marketplace_return_pending"], channelStatus: "Dalam Pengembalian" });
      expect((await movementsFor(tx, [s.sku("M")])).filter((movement) => movement.type === "return")).toHaveLength(0);
    });
  });

  test("a manual Retur (transitionOrderStatus) clears the return flag too", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      committed(await previewAndCommit(tx, parse([{ orderNo: s.orderNo("A"), status: "Dalam Pengembalian", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]), staff.id));
      const order = await orderByChannelNo(tx, s.orderNo("A"));
      const { transitionOrderStatus } = await import("@ammari/commerce/orders");
      await transitionOrderStatus(order!.id, "returned", staff.id, tx);
      expect((await orderByChannelNo(tx, s.orderNo("A")))?.needsAttention).toEqual([]);
    });
  });
});

describe("commitImport: voucher and fees on re-import (test 38)", () => {
  test("voucher and fees are updated; a fee column missing from a later file leaves the stored fee as is", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const lines = [{ sku: s.sku("M"), qty: 2, lineTotal: 498_000 }];
      committed(await previewAndCommit(tx, parse([{ orderNo: s.orderNo("A"), status: "Selesai", sellerVoucher: 10_000, adminFee: 4_000, serviceFee: 3_000, lines }]), staff.id));

      const rows = withoutColumn(shopeeRows([{ orderNo: s.orderNo("A"), status: "Selesai", sellerVoucher: 15_000, adminFee: 4_500, lines }]), "Biaya Layanan");
      const parsed = parseRows(rows);
      expect(parsed.warnings.some((warning) => warning.includes("Biaya Layanan"))).toBe(true);
      const outcome = committed(await previewAndCommit(tx, parsed, staff.id));
      expect(outcome).toMatchObject({ created: 0, updated: 1 });

      const order = await orderByChannelNo(tx, s.orderNo("A"));
      expect(order).toMatchObject({ discountAmount: 15_000, totalAmount: 483_000, subtotalAmount: 498_000 });
      const fees = await tx.select().from(orderChannelFees).where(eq(orderChannelFees.orderId, order!.id));
      expect(Object.fromEntries(fees.map((fee) => [fee.component, fee.amount]))).toEqual({ admin_fee: 4_500, service_fee: 3_000, affiliate_commission: 0 });
      expect(fees.find((fee) => fee.component === "admin_fee")?.importBatchId).toBe(outcome.batchId);
      expect(fees.find((fee) => fee.component === "service_fee")?.importBatchId).not.toBe(outcome.batchId);
      // Stock untouched by a voucher/fee update.
      expect((await movementsFor(tx, [s.sku("M")])).filter((movement) => movement.type === "sale")).toHaveLength(1);
    });
  });
});

describe("commitImport: manual SKU match (test 39)", () => {
  test("one import_sku_match audit row per override, listed in the batch summary", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const fileSku = `${s.sku("M")}X`;
      const parsed = parse([
        { orderNo: s.orderNo("A"), status: "Selesai", lines: [{ sku: fileSku, qty: 1, lineTotal: 249_000 }] },
        { orderNo: s.orderNo("B"), status: "Selesai", lines: [{ sku: fileSku, qty: 1, lineTotal: 249_000 }] },
      ]);
      const outcome = committed(await previewAndCommit(tx, parsed, staff.id, { skuOverrides: { [fileSku]: s.sku("M") } }));
      expect(outcome.created).toBe(2);

      const matches = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, outcome.batchId), eq(auditLog.action, "import_sku_match")));
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ entityType: "import_batch", actorStaffUserId: staff.id, after: { fileSku, adminSku: s.sku("M"), orderNos: [s.orderNo("A"), s.orderNo("B")] } });
      const [batch] = await tx.select().from(importBatches).where(eq(importBatches.id, outcome.batchId));
      expect(batch!.summary).toMatchObject({ skuMatches: [{ fileSku, adminSku: s.sku("M"), channelOrderNos: [s.orderNo("A"), s.orderNo("B")] }] });
      const items = await tx.select().from(orderItems).innerJoin(orders, eq(orders.id, orderItems.orderId)).where(eq(orders.importBatchId, outcome.batchId));
      expect(items.every((row) => row.order_items.sku === s.sku("M"))).toBe(true);
    });
  });
});

describe("commitImport: drift and refusals (tests 40, 42, 43)", () => {
  test("stock adjusted between preview and Simpan: nothing written, the fresh preview returned (test 40)", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"], { M: 2 });
      const staff = await insertStaffUser(tx);
      const parsed = parse([{ orderNo: s.orderNo("A"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 2, lineTotal: 498_000 }] }]);
      const preview = await plan(tx, parsed);
      expect(preview.counts.create).toBe(1);

      await tx.insert(stockMovements).values({ sku: s.sku("M"), qty: -1, valueAmount: -100_000, type: "adjustment", refType: "manual", reason: "lost" });
      const before = await tableCounts(tx);
      const outcome = await commitImport({ parsed, fileName: "pesanan.xlsx", options: {}, expectedDigest: preview.digest, actorStaffUserId: staff.id }, tx);
      expect(outcome.kind).toBe("stale");
      if (outcome.kind !== "stale") return;
      expect(outcome.plan.counts).toMatchObject({ create: 0, review: 1 });
      expect(outcome.plan.digest).not.toBe(preview.digest);
      expect(await tableCounts(tx)).toEqual(before);
    });
  });

  test("an existing order moved under its row lock (after the in-transaction plan): drift, nothing written", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const lines = [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }];
      committed(await previewAndCommit(tx, parse([{ orderNo: s.orderNo("A"), status: "Perlu Dikirim", lines }]), staff.id));
      const parsed = parse([{ orderNo: s.orderNo("A"), status: "Selesai", lines }]);
      const preview = await plan(tx, parsed);
      const order = await orderByChannelNo(tx, s.orderNo("A"));
      const before = await tableCounts(tx);

      // The plan as the transaction made it, then the order moves before the commit locks it.
      const result = await commitMarketplaceImport(
        {
          channelId: "shopee",
          actorStaffUserId: staff.id,
          batch: { filename: "pesanan.xlsx", fileSha256: parsed.fileSha256, rowCount: 1 },
          replan: async (inner) => {
            const fresh = await plan(inner, parsed);
            expect(fresh.digest).toBe(preview.digest);
            await inner.update(orders).set({ discountAmount: 1_000, totalAmount: sql`${orders.totalAmount} - 1000` }).where(eq(orders.id, order!.id));
            return { proceed: true, plan: toCommitPlan(fresh) };
          },
        },
        tx,
      );
      expect(result.status).toBe("drift");
      // The savepoint rolled back the manual change as well: nothing at all was written.
      expect(await tableCounts(tx)).toEqual(before);
      expect((await orderByChannelNo(tx, s.orderNo("A")))?.discountAmount).toBe(0);
    });
  });

  test("a failure in the middle rolls the whole transaction back, no batch row (test 42)", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const parsed = parse([
        { orderNo: s.orderNo("A"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
        { orderNo: s.orderNo("B"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
      ]);
      const fresh = await plan(tx, parsed);
      const commitPlan = toCommitPlan(fresh);
      // Order B fails at its line insert (a SKU no variant has: the order_items FK refuses it).
      commitPlan.creates[1]!.lines[0]!.sku = "TIDAK-ADA-SKU-INI";
      const before = await tableCounts(tx);
      await expect(
        commitMarketplaceImport({ channelId: "shopee", actorStaffUserId: staff.id, batch: { filename: "x.xlsx", fileSha256: parsed.fileSha256, rowCount: 2 }, replan: async () => ({ proceed: true, plan: commitPlan }) }, tx),
      ).rejects.toThrow();
      expect(await tableCounts(tx)).toEqual(before);
      expect(await orderByChannelNo(tx, s.orderNo("A"))).toBeUndefined();
    });
  });

  test("the Shopee lock: refused on the server while SHOPEE_MAPPING_VERIFIED is false, whatever digest is sent (test 43)", async () => {
    expect(SHOPEE_MAPPING_VERIFIED).toBe(false);
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const parsed = parse([{ orderNo: s.orderNo("A"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }], { locked: true });
      expect(parsed.mappingVerified).toBe(false);
      const preview = await plan(tx, parsed);
      expect(preview.counts.create).toBe(1);
      const before = await tableCounts(tx);
      const outcome = await commitImport({ parsed, fileName: "pesanan.xlsx", options: {}, expectedDigest: preview.digest, actorStaffUserId: staff.id }, tx);
      expect(outcome.kind).toBe("blocked");
      if (outcome.kind === "blocked") expect(outcome.blockers[0]).toContain("Pemetaan kolom Shopee belum diverifikasi");
      expect(await tableCounts(tx)).toEqual(before);
    });
  });

  test("rows without an order number block the whole file, even with a matching digest", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const parsed = parse([
        { orderNo: s.orderNo("A"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
        { orderNo: "", status: "Selesai", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
      ]);
      expect(parsed.saveBlockers).toHaveLength(1);
      const preview = await plan(tx, parsed);
      const outcome = await commitImport({ parsed, fileName: "pesanan.xlsx", options: {}, expectedDigest: preview.digest, actorStaffUserId: staff.id }, tx);
      expect(outcome.kind).toBe("blocked");
      expect(await orderByChannelNo(tx, s.orderNo("A"))).toBeUndefined();
    });
  });

  test("a stale digest is refused with the fresh preview", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const parsed = parse([{ orderNo: s.orderNo("A"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]);
      const outcome = await commitImport({ parsed, fileName: "pesanan.xlsx", options: {}, expectedDigest: "0".repeat(64), actorStaffUserId: staff.id }, tx);
      expect(outcome.kind).toBe("stale");
      expect(await orderByChannelNo(tx, s.orderNo("A"))).toBeUndefined();
    });
  });

  test("an order created since the plan (same key): the INSERT does nothing and the commit drifts", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const parsed = parse([{ orderNo: s.orderNo("A"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]);
      const result = await commitMarketplaceImport(
        {
          channelId: "shopee",
          actorStaffUserId: staff.id,
          batch: { filename: "x.xlsx", fileSha256: parsed.fileSha256, rowCount: 1 },
          replan: async (inner) => {
            const fresh = await plan(inner, parsed);
            await insertOrder(inner, { channelId: "shopee", channelOrderNo: s.orderNo("A"), status: "to_ship" as OrderStatus });
            return { proceed: true, plan: toCommitPlan(fresh) };
          },
        },
        tx,
      );
      expect(result.status).toBe("drift");
    });
  });
});

describe("commitImport: concurrency (test 41)", () => {
  test("two concurrent commits of overlapping files: no duplicate order, no double stock movement, the loser gets a fresh preview", async () => {
    // Real commits on separate connections: the advisory lock and row locks only contend across
    // transactions. Cleaned up by hand afterwards (orders, history, fees, audit, stock).
    const s = await seedVariants(testDb, ["M"]);
    const staff = await insertStaffUser(testDb);
    const lines = [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }];
    const first = parse([
      { orderNo: s.orderNo("A"), status: "Selesai", lines },
      { orderNo: s.orderNo("B"), status: "Selesai", lines },
    ]);
    const second = parse([
      { orderNo: s.orderNo("B"), status: "Selesai", lines },
      { orderNo: s.orderNo("C"), status: "Selesai", lines },
    ]);
    const batchIds: string[] = [];
    try {
      const [previewFirst, previewSecond] = [await plan(testDb, first), await plan(testDb, second)];
      const outcomes = await Promise.all([
        commitImport({ parsed: first, fileName: "a.xlsx", options: {}, expectedDigest: previewFirst.digest, actorStaffUserId: staff.id }, testDb),
        commitImport({ parsed: second, fileName: "b.xlsx", options: {}, expectedDigest: previewSecond.digest, actorStaffUserId: staff.id }, testDb),
      ]);
      for (const outcome of outcomes) if (outcome.kind === "committed") batchIds.push(outcome.batchId);
      expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["committed", "stale"]);
      const loser = outcomes.find((outcome) => outcome.kind === "stale");
      expect(loser?.kind === "stale" && loser.plan.counts.unchanged).toBe(1);

      const created = await testDb.select().from(orders).where(inArray(orders.channelOrderNo, [s.orderNo("A"), s.orderNo("B"), s.orderNo("C")]));
      const sales = (await movementsFor(testDb, [s.sku("M")])).filter((movement) => movement.type === "sale");
      expect(created).toHaveLength(2);
      expect(sales).toHaveLength(2);
    } finally {
      const created = await testDb.select({ id: orders.id }).from(orders).where(inArray(orders.channelOrderNo, [s.orderNo("A"), s.orderNo("B"), s.orderNo("C")]));
      const orderIds = created.map((row) => row.id);
      if (orderIds.length > 0) {
        await testDb.delete(importBatchOrders).where(inArray(importBatchOrders.orderId, orderIds));
        await testDb.delete(orderChannelFees).where(inArray(orderChannelFees.orderId, orderIds));
        await testDb.delete(auditLog).where(inArray(auditLog.entityId, [...orderIds, ...batchIds]));
        await testDb.delete(orders).where(inArray(orders.id, orderIds));
      }
      if (batchIds.length > 0) await testDb.delete(importBatches).where(inArray(importBatches.id, batchIds));
      await withTriggerDisabled(testDb, "stock_movements", "prevent_stock_movement_mutation", () => testDb.delete(stockMovements).where(inArray(stockMovements.sku, s.cleanup.skus)));
      await testDb.delete(productVariants).where(inArray(productVariants.sku, s.cleanup.skus));
      await testDb.delete(products).where(eq(products.id, s.cleanup.productId));
      await testDb.delete(fabricColors).where(inArray(fabricColors.id, s.cleanup.colorIds));
      await testDb.delete(fabrics).where(eq(fabrics.id, s.cleanup.fabricId));
    }
  });
});
