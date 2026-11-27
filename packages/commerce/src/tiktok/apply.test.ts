import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  auditLog,
  fabricColors,
  fabrics,
  orderItems,
  orders,
  products,
  productVariants,
  stockMovements,
  tiktokOrderSnapshots,
  tiktokOrders,
  tiktokSkuMappings,
} from "@ammari/db/schema";
import { insertProductVariant, insertStaffUser, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { projectTikTokOrder } from "@ammari/tiktok-shop";
import { ActionError } from "../errors";
import { clearAttentionFlag } from "../payments/staff";
import { createOrder, transitionOrderStatus } from "../orders/lifecycle";
import { currentBalanceForSkuLocked } from "../stock/ledger";
import { applyTikTokOrder, listTikTokOrdersToApply } from "./apply";
import { ingestTikTokOrder } from "./order-store";

// docs/plans/tiktok-shop-integration.md T5 against a real database: applying a TikTok order to admin
// orders and stock through createOrder's stock helper and transitionOrderStatus. Every test rolls back,
// except the two concurrency tests, which need real commits (and clean up after themselves).

const HOUR = 3_600_000;
const MIN = 60_000;
const BASE = new Date("2026-12-02T03:00:00.000Z");
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

let counter = 0;
function newTikTokId(): string {
  counter += 1;
  return `5770${Date.now()}${counter}`.slice(0, 18) + String(counter).padStart(3, "0");
}

interface Fixture {
  skuA: string;
  skuB: string;
}

async function catalog(db: TestDatabase, stockA = 5, stockB = 5): Promise<Fixture & { cleanup: { fabricId: string; colorId: string; productIds: string[] } }> {
  const { fabric, color, product, variant } = await insertProductVariant(db);
  const second = await insertVariantForProduct(db, fabric.id, color.id, {}, "L");
  if (stockA > 0) await db.insert(stockMovements).values({ sku: variant.sku, qty: stockA, valueAmount: stockA * 100_000, type: "production", refType: "manual" });
  if (stockB > 0) await db.insert(stockMovements).values({ sku: second.variant.sku, qty: stockB, valueAmount: stockB * 90_000, type: "production", refType: "manual" });
  return { skuA: variant.sku, skuB: second.variant.sku, cleanup: { fabricId: fabric.id, colorId: color.id, productIds: [product.id, second.product.id] } };
}

async function map(db: TestDatabase, tiktokSkuId: string, variantSku: string) {
  await db.insert(tiktokSkuMappings).values({ tiktokSkuId, variantSku, source: "auto_seller_sku", sellerSku: variantSku });
}

function rawOrder(id: string, updateTime: Date, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: "AWAITING_SHIPMENT",
    create_time: seconds(updateTime) - 2 * 3600,
    update_time: seconds(updateTime),
    paid_time: seconds(updateTime) - 2 * 3600,
    is_on_hold_order: false,
    buyer_message: "tolong bungkus rapi",
    payment: { currency: "IDR", sub_total: "500000", seller_discount: "20000", platform_discount: "5000", total_amount: "475000" },
    line_items: [
      { id: `${id}-1`, sku_id: `tt-a-${id}`, original_price: "259000", seller_discount: "10000", platform_discount: "5000", currency: "IDR" },
      { id: `${id}-2`, sku_id: `tt-b-${id}`, original_price: "241000", seller_discount: "0", platform_discount: "0", currency: "IDR" },
    ],
    ...extra,
  };
}

async function ingest(db: TestDatabase, raw: Record<string, unknown>, now: Date) {
  const projected = projectTikTokOrder(raw);
  if (!projected.ok) throw new Error("projection failed");
  return ingestTikTokOrder(db, projected.order, "poll", now);
}

async function adminOrder(db: TestDatabase, tiktokOrderId: string) {
  const rows = await db.select().from(orders).where(and(eq(orders.channelId, "tiktok"), eq(orders.channelOrderNo, tiktokOrderId)));
  return rows;
}

async function balance(db: TestDatabase, sku: string) {
  return (await currentBalanceForSkuLocked(db as never, sku)).qty;
}

async function movementsOf(db: TestDatabase, orderId: string) {
  const items = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId));
  if (items.length === 0) return [];
  return db
    .select({ type: stockMovements.type, qty: stockMovements.qty, sku: stockMovements.sku, valueAmount: stockMovements.valueAmount })
    .from(stockMovements)
    .where(and(eq(stockMovements.refType, "order_item"), inArray(stockMovements.refId, items.map((item) => item.id))));
}

async function projection(db: TestDatabase, id: string) {
  const [row] = await db.select().from(tiktokOrders).where(eq(tiktokOrders.tiktokOrderId, id));
  return row!;
}

async function auditsFor(db: TestDatabase, entityId: string) {
  return db.select({ action: auditLog.action, entityType: auditLog.entityType, after: auditLog.after }).from(auditLog).where(eq(auditLog.entityId, entityId));
}

async function setup(db: TestDatabase, stockA = 5, stockB = 5) {
  const fixture = await catalog(db, stockA, stockB);
  const id = newTikTokId();
  await map(db, `tt-a-${id}`, fixture.skuA);
  await map(db, `tt-b-${id}`, fixture.skuB);
  return { ...fixture, id };
}

describe("applyTikTokOrder: creating", () => {
  test("first paid report → order at to_ship, one sale movement per line, amounts per Q7, audit tiktok_create", async () => {
    await withRollback(async (tx) => {
      const { id, skuA, skuB } = await setup(tx);
      await ingest(tx, rawOrder(id, BASE), BASE);
      const result = await applyTikTokOrder(tx, id, { now: BASE, source: "poll" });
      expect(result.kind).toBe("created");

      const [order] = await adminOrder(tx, id);
      expect(order).toMatchObject({ status: "to_ship", subtotalAmount: 500_000, discountAmount: 20_000, shippingAmount: 0, totalAmount: 480_000, channelStatus: "AWAITING_SHIPMENT", customerId: null, buyerUsername: null, shippingAddress: null, notes: null, createdByStaffUserId: null });
      expect(order!.needsAttention).toEqual([]);
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order!.id));
      expect(items.map((item) => ({ sku: item.sku, qty: item.qty, unitPrice: item.unitPrice, listUnitPrice: item.listUnitPrice })).sort((a, b) => a.sku.localeCompare(b.sku))).toEqual(
        [
          { sku: skuA, qty: 1, unitPrice: 259_000, listUnitPrice: null },
          { sku: skuB, qty: 1, unitPrice: 241_000, listUnitPrice: null },
        ].sort((a, b) => a.sku.localeCompare(b.sku)),
      );
      const movements = await movementsOf(tx, order!.id);
      expect(movements).toHaveLength(2);
      expect(movements.every((movement) => movement.type === "sale" && movement.qty === -1)).toBe(true);
      expect(await balance(tx, skuA)).toBe(4);
      expect(await balance(tx, skuB)).toBe(4);

      const row = await projection(tx, id);
      expect(row).toMatchObject({ orderId: order!.id, applyState: "applied", heldReason: null });
      expect(row.appliedUpdateTime).toEqual(row.latestUpdateTime);
      const audits = await auditsFor(tx, order!.id);
      expect(audits.map((audit) => audit.action)).toContain("tiktok_create");
      const create = audits.find((audit) => audit.action === "tiktok_create");
      expect(create?.after).toMatchObject({ source: "poll", tiktokOrderId: id, tiktokStatus: "AWAITING_SHIPMENT" });
      // No buyer data or message in the audit row.
      expect(JSON.stringify(create?.after)).not.toContain("bungkus");
    });
  });

  test("a replayed snapshot changes nothing: no second order, no movement, no audit row, no write", async () => {
    await withRollback(async (tx) => {
      const { id } = await setup(tx);
      await ingest(tx, rawOrder(id, BASE), BASE);
      await applyTikTokOrder(tx, id, { now: BASE, source: "poll" });
      const [order] = await adminOrder(tx, id);
      const before = { order, projection: await projection(tx, id), audits: (await tx.select({ id: auditLog.id }).from(auditLog)).length, movements: await movementsOf(tx, order!.id) };

      await ingest(tx, rawOrder(id, BASE), BASE);
      expect(await applyTikTokOrder(tx, id, { now: new Date(BASE.getTime() + MIN), source: "webhook" })).toMatchObject({ kind: "unchanged" });
      expect(await adminOrder(tx, id)).toEqual([before.order]);
      expect(await projection(tx, id)).toEqual(before.projection);
      expect((await tx.select({ id: auditLog.id }).from(auditLog)).length).toBe(before.audits);
      expect(await movementsOf(tx, order!.id)).toEqual(before.movements);
    });
  });

  test("UNPAID is skipped: no order, no stock", async () => {
    await withRollback(async (tx) => {
      const { id, skuA } = await setup(tx);
      await ingest(tx, rawOrder(id, BASE, { status: "UNPAID", paid_time: undefined }), BASE);
      expect(await applyTikTokOrder(tx, id, { now: BASE, source: "poll" })).toMatchObject({ kind: "skipped", reason: "unpaid" });
      expect(await adminOrder(tx, id)).toHaveLength(0);
      expect(await balance(tx, skuA)).toBe(5);
      expect((await projection(tx, id)).applyState).toBe("skipped_unpaid");
    });
  });

  test("a buyer cancelling in the hold window: to_ship → cancelled, exact return movements, stock net 0", async () => {
    await withRollback(async (tx) => {
      const { id, skuA, skuB } = await setup(tx);
      const paid = new Date(BASE.getTime() - 10 * MIN);
      await ingest(tx, rawOrder(id, BASE, { paid_time: seconds(paid) }), BASE);
      await applyTikTokOrder(tx, id, { now: BASE, source: "webhook" });
      const [order] = await adminOrder(tx, id);
      expect(order!.needsAttention).toEqual(["tiktok_on_hold"]);
      expect(await balance(tx, skuA)).toBe(4);

      const later = new Date(BASE.getTime() + 20 * MIN);
      await ingest(tx, rawOrder(id, later, { status: "CANCELLED", paid_time: seconds(paid), cancel_time: seconds(later) }), later);
      expect(await applyTikTokOrder(tx, id, { now: later, source: "webhook" })).toMatchObject({ kind: "updated" });
      const [cancelled] = await adminOrder(tx, id);
      expect(cancelled!.status).toBe("cancelled");
      expect(cancelled!.needsAttention).toEqual([]);
      const movements = await movementsOf(tx, order!.id);
      expect(movements.filter((movement) => movement.type === "return")).toHaveLength(2);
      expect(movements.reduce((sum, movement) => sum + movement.valueAmount, 0)).toBe(0);
      expect(await balance(tx, skuA)).toBe(5);
      expect(await balance(tx, skuB)).toBe(5);
    });
  });

  test("short stock is held (nothing written), then applied on a later pass once stock is recorded", async () => {
    await withRollback(async (tx) => {
      const { id, skuA, skuB } = await setup(tx, 0, 5);
      await ingest(tx, rawOrder(id, BASE), BASE);
      expect(await applyTikTokOrder(tx, id, { now: BASE, source: "poll" })).toMatchObject({ kind: "held", reason: "short_stock", detail: skuA });
      expect(await adminOrder(tx, id)).toHaveLength(0);
      expect(await balance(tx, skuB)).toBe(5);
      expect(await projection(tx, id)).toMatchObject({ applyState: "held", heldReason: "short_stock", orderId: null });
      // A second pass while still short records nothing new.
      const auditCount = (await auditsFor(tx, id)).length;
      expect(await applyTikTokOrder(tx, id, { now: BASE, source: "poll" })).toMatchObject({ kind: "held" });
      expect((await auditsFor(tx, id)).length).toBe(auditCount);

      // A hold is re-checked after its back-off, not on every run.
      expect((await listTikTokOrdersToApply(tx, BASE)).ids).not.toContain(id);
      expect((await listTikTokOrdersToApply(tx, new Date(BASE.getTime() + 16 * MIN))).ids).toContain(id);
      await tx.insert(stockMovements).values({ sku: skuA, qty: 1, valueAmount: 100_000, type: "production", refType: "manual" });
      expect(await applyTikTokOrder(tx, id, { now: BASE, source: "poll" })).toMatchObject({ kind: "created" });
      expect(await balance(tx, skuA)).toBe(0);
      expect(await projection(tx, id)).toMatchObject({ applyState: "applied", heldReason: null });
      expect((await listTikTokOrdersToApply(tx, new Date(BASE.getTime() + 16 * MIN))).ids).not.toContain(id);
    });
  });

  test("an unknown SKU is held until mapped, then applied", async () => {
    await withRollback(async (tx) => {
      const fixture = await catalog(tx);
      const id = newTikTokId();
      await map(tx, `tt-a-${id}`, fixture.skuA);
      await ingest(tx, rawOrder(id, BASE), BASE);
      expect(await applyTikTokOrder(tx, id, { now: BASE, source: "poll" })).toMatchObject({ kind: "held", reason: "unknown_sku" });
      expect(await balance(tx, fixture.skuA)).toBe(5);
      const holds = await auditsFor(tx, id);
      expect(holds.map((audit) => audit.action)).toEqual(["tiktok_hold"]);
      expect(holds[0]?.after).toMatchObject({ reason: "unknown_sku" });

      await map(tx, `tt-b-${id}`, fixture.skuB);
      expect(await applyTikTokOrder(tx, id, { now: BASE, source: "poll" })).toMatchObject({ kind: "created" });
      expect(await adminOrder(tx, id)).toHaveLength(1);
    });
  });

  test("IN_TRANSIT first seen: created then shipped, marketplace_shipped_at = collection_time", async () => {
    await withRollback(async (tx) => {
      const { id } = await setup(tx);
      const collected = new Date(BASE.getTime() - HOUR);
      await ingest(tx, rawOrder(id, BASE, { status: "IN_TRANSIT", collection_time: seconds(collected) }), BASE);
      expect(await applyTikTokOrder(tx, id, { now: BASE, source: "backfill" })).toMatchObject({ kind: "created" });
      const [order] = await adminOrder(tx, id);
      expect(order).toMatchObject({ status: "shipped", marketplaceShippedAt: collected });
      expect(order!.shippedAt).not.toBeNull();
    });
  });
});

describe("applyTikTokOrder: moving an applied order", () => {
  test("IN_TRANSIT sets marketplace_shipped_at once; a later different collection_time is flagged, not overwritten", async () => {
    await withRollback(async (tx) => {
      const { id } = await setup(tx);
      await ingest(tx, rawOrder(id, BASE), BASE);
      await applyTikTokOrder(tx, id, { now: BASE, source: "poll" });
      const collected = new Date(BASE.getTime() + HOUR);
      const t1 = new Date(BASE.getTime() + 2 * HOUR);
      await ingest(tx, rawOrder(id, t1, { status: "IN_TRANSIT", collection_time: seconds(collected) }), t1);
      expect(await applyTikTokOrder(tx, id, { now: t1, source: "webhook" })).toMatchObject({ kind: "updated" });
      const [shipped] = await adminOrder(tx, id);
      expect(shipped).toMatchObject({ status: "shipped", marketplaceShippedAt: collected, channelStatus: "IN_TRANSIT" });

      const t2 = new Date(BASE.getTime() + 5 * HOUR);
      await ingest(tx, rawOrder(id, t2, { status: "DELIVERED", collection_time: seconds(collected) + 600 }), t2);
      await applyTikTokOrder(tx, id, { now: t2, source: "poll" });
      const [delivered] = await adminOrder(tx, id);
      expect(delivered).toMatchObject({ status: "shipped", marketplaceShippedAt: collected, channelStatus: "DELIVERED" });
      expect((await projection(tx, id)).reviewFlags).toContain("tiktok_ship_time_changed");

      const t3 = new Date(BASE.getTime() + 50 * HOUR);
      await ingest(tx, rawOrder(id, t3, { status: "COMPLETED", collection_time: seconds(collected) }), t3);
      await applyTikTokOrder(tx, id, { now: t3, source: "poll" });
      const [completed] = await adminOrder(tx, id);
      expect(completed).toMatchObject({ status: "completed", marketplaceShippedAt: collected, marketplaceCompletedAt: new Date(seconds(t3) * 1000) });
      const audits = await auditsFor(tx, completed!.id);
      expect(audits.filter((audit) => audit.action === "tiktok_update").length).toBeGreaterThanOrEqual(3);
    });
  });

  test("CANCELLED after shipping (failed delivery): flags and marketplace_returned_at only, stock untouched until received", async () => {
    await withRollback(async (tx) => {
      const { id, skuA } = await setup(tx);
      const t1 = new Date(BASE.getTime() + HOUR);
      await ingest(tx, rawOrder(id, t1, { status: "IN_TRANSIT", collection_time: seconds(BASE) }), t1);
      await applyTikTokOrder(tx, id, { now: t1, source: "poll" });
      const t2 = new Date(BASE.getTime() + 30 * HOUR);
      await ingest(tx, rawOrder(id, t2, { status: "CANCELLED", collection_time: seconds(BASE), cancel_time: seconds(t2) }), t2);
      await applyTikTokOrder(tx, id, { now: t2, source: "poll" });
      const [order] = await adminOrder(tx, id);
      expect(order).toMatchObject({ status: "shipped", marketplaceReturnedAt: new Date(seconds(t2) * 1000) });
      expect(order!.needsAttention).toEqual(["marketplace_return_pending", "marketplace_return_in_transit"]);
      expect(await balance(tx, skuA)).toBe(4);
      expect((await movementsOf(tx, order!.id)).filter((movement) => movement.type === "return")).toHaveLength(0);

      // The parcel comes back: Retur (the only path) restores stock and clears both flags.
      const staff = await insertStaffUser(tx);
      await transitionOrderStatus(order!.id, "returned", staff.id, tx);
      const [returned] = await adminOrder(tx, id);
      expect(returned!.needsAttention).toEqual([]);
      expect(await balance(tx, skuA)).toBe(5);
    });
  });

  test("ON_HOLD: created with the flag; the gate re-check clears it once AWAITING_SHIPMENT passes the hour (no new snapshot)", async () => {
    await withRollback(async (tx) => {
      const { id } = await setup(tx);
      const paid = new Date(BASE.getTime() - 5 * MIN);
      await ingest(tx, rawOrder(id, BASE, { status: "ON_HOLD", paid_time: seconds(paid) }), BASE);
      await applyTikTokOrder(tx, id, { now: BASE, source: "poll" });
      expect((await adminOrder(tx, id))[0]!.needsAttention).toEqual(["tiktok_on_hold"]);

      const t1 = new Date(BASE.getTime() + 10 * MIN);
      await ingest(tx, rawOrder(id, t1, { status: "AWAITING_SHIPMENT", paid_time: seconds(paid) }), t1);
      await applyTikTokOrder(tx, id, { now: t1, source: "webhook" });
      expect((await adminOrder(tx, id))[0]!.needsAttention).toEqual(["tiktok_on_hold"]);
      expect((await listTikTokOrdersToApply(tx, t1)).ids).toContain(id);

      // An hour after payment, with no webhook: the cron's re-check clears the flag.
      const t2 = new Date(paid.getTime() + HOUR + MIN);
      expect(await applyTikTokOrder(tx, id, { now: t2, source: "poll" })).toMatchObject({ kind: "updated" });
      const [order] = await adminOrder(tx, id);
      expect(order!.needsAttention).toEqual([]);
      expect(order!.status).toBe("to_ship");
      expect(await applyTikTokOrder(tx, id, { now: t2, source: "poll" })).toMatchObject({ kind: "unchanged" });
      expect((await listTikTokOrdersToApply(tx, t2)).ids).not.toContain(id);
    });
  });

  test("staff cannot mark a TikTok order shipped while it waits; once packable they can", async () => {
    await withRollback(async (tx) => {
      const { id } = await setup(tx);
      const paid = new Date(BASE.getTime() - 5 * MIN);
      await ingest(tx, rawOrder(id, BASE, { paid_time: seconds(paid) }), BASE);
      await applyTikTokOrder(tx, id, { now: BASE, source: "poll" });
      const [order] = await adminOrder(tx, id);
      const staff = await insertStaffUser(tx);
      await expect(transitionOrderStatus(order!.id, "shipped", staff.id, tx, { now: BASE })).rejects.toThrow(ActionError);
      await transitionOrderStatus(order!.id, "shipped", staff.id, tx, { now: new Date(paid.getTime() + HOUR) });
      expect((await adminOrder(tx, id))[0]!.status).toBe("shipped");
    });
  });
});

describe("applyTikTokOrder: the TikTok hold flag never sticks", () => {
  test("shipped by staff before the cron cleared the hold: the re-check clears it anyway", async () => {
    await withRollback(async (tx) => {
      const { id } = await setup(tx);
      const paid = new Date(BASE.getTime() - 5 * MIN);
      await ingest(tx, rawOrder(id, BASE, { paid_time: seconds(paid) }), BASE);
      await applyTikTokOrder(tx, id, { now: BASE, source: "poll" });
      const [order] = await adminOrder(tx, id);
      const staff = await insertStaffUser(tx);
      const later = new Date(paid.getTime() + HOUR + MIN);
      await transitionOrderStatus(order!.id, "shipped", staff.id, tx, { now: later });
      expect((await adminOrder(tx, id))[0]!.needsAttention).toEqual(["tiktok_on_hold"]);
      expect((await listTikTokOrdersToApply(tx, later)).ids).toContain(id);
      await applyTikTokOrder(tx, id, { now: later, source: "recheck" });
      expect((await adminOrder(tx, id))[0]!.needsAttention).toEqual([]);
    });
  });

  test("Tandai beres refuses the hold while applying is on, allows it while the switch is off", async () => {
    await withRollback(async (tx) => {
      const { id } = await setup(tx);
      await ingest(tx, rawOrder(id, BASE, { paid_time: seconds(BASE) - 60 }), BASE);
      await applyTikTokOrder(tx, id, { now: BASE, source: "poll" });
      const [order] = await adminOrder(tx, id);
      const staff = await insertStaffUser(tx);
      await tx.execute(sql`insert into tiktok_shop_connections (shop_id, shop_cipher, status, access_token_ct, refresh_token_ct, token_key_version, connected_at, orders_apply_enabled)
        values (${`shop-${id}`}, 'c', 'active', '\\x00'::bytea, '\\x00'::bytea, 1, now(), true)`);
      await expect(clearAttentionFlag(tx, order!.id, "tiktok_on_hold", staff.id)).rejects.toThrow(ActionError);
      await tx.execute(sql`update tiktok_shop_connections set orders_apply_enabled = false where shop_id = ${`shop-${id}`}`);
      expect((await clearAttentionFlag(tx, order!.id, "tiktok_on_hold", staff.id)).needsAttention).toEqual([]);
    });
  });
});

describe("applyTikTokOrder: hand-typed TikTok orders", () => {
  test("a hand-typed order with the same number is matched, never duplicated; its stock left once", async () => {
    await withRollback(async (tx) => {
      const { id, skuA, skuB } = await setup(tx);
      const staff = await insertStaffUser(tx);
      const typed = await createOrder(
        { channelId: "tiktok", channelOrderNo: id, orderDate: "2026-12-02", items: [{ sku: skuA, qty: 1, unitPrice: 249_000 }, { sku: skuB, qty: 1, unitPrice: 241_000 }], discountAmount: 0, shippingAmount: 0, status: "to_ship" },
        staff.id,
        tx,
      );
      expect(await balance(tx, skuA)).toBe(4);
      await ingest(tx, rawOrder(id, BASE), BASE);
      expect(await applyTikTokOrder(tx, id, { now: BASE, source: "poll" })).toMatchObject({ kind: "updated", orderId: typed!.id });
      expect(await adminOrder(tx, id)).toHaveLength(1);
      expect(await balance(tx, skuA)).toBe(4);
      // Its typed amounts are not rewritten.
      expect((await adminOrder(tx, id))[0]).toMatchObject({ subtotalAmount: 490_000, totalAmount: 490_000, channelStatus: "AWAITING_SHIPMENT" });
      expect((await projection(tx, id)).orderId).toBe(typed!.id);

      const t1 = new Date(BASE.getTime() + HOUR);
      await ingest(tx, rawOrder(id, t1, { status: "IN_TRANSIT", collection_time: seconds(t1) }), t1);
      await applyTikTokOrder(tx, id, { now: t1, source: "poll" });
      expect((await adminOrder(tx, id))[0]).toMatchObject({ status: "shipped", marketplaceShippedAt: new Date(seconds(t1) * 1000) });
    });
  });

  test("a hand-typed order whose lines differ is held (lines_differ) and left untouched", async () => {
    await withRollback(async (tx) => {
      const { id, skuA } = await setup(tx);
      const staff = await insertStaffUser(tx);
      const typed = await createOrder(
        { channelId: "tiktok", channelOrderNo: id, orderDate: "2026-12-02", items: [{ sku: skuA, qty: 2, unitPrice: 249_000 }], discountAmount: 0, shippingAmount: 0, status: "to_ship" },
        staff.id,
        tx,
      );
      await ingest(tx, rawOrder(id, new Date(BASE.getTime() + HOUR), { status: "IN_TRANSIT", collection_time: seconds(BASE) }), BASE);
      expect(await applyTikTokOrder(tx, id, { now: BASE, source: "poll" })).toMatchObject({ kind: "held", reason: "lines_differ" });
      const [order] = await adminOrder(tx, id);
      expect(order).toMatchObject({ id: typed!.id, status: "to_ship", marketplaceShippedAt: null, channelStatus: null });
      expect(await balance(tx, skuA)).toBe(3);
    });
  });
});

// ---- Concurrency (real commits) ---------------------------------------------------------------

async function cleanup(fixture: Awaited<ReturnType<typeof catalog>>, tiktokOrderIds: string[], extraOrderIds: string[] = []) {
  const tiktokRows = tiktokOrderIds.length > 0 ? await testDb.select({ orderId: tiktokOrders.orderId }).from(tiktokOrders).where(inArray(tiktokOrders.tiktokOrderId, tiktokOrderIds)) : [];
  const admin = tiktokOrderIds.length > 0 ? await testDb.select({ id: orders.id }).from(orders).where(and(eq(orders.channelId, "tiktok"), inArray(orders.channelOrderNo, tiktokOrderIds))) : [];
  const orderIds = [...new Set([...admin.map((row) => row.id), ...extraOrderIds, ...tiktokRows.flatMap((row) => (row.orderId ? [row.orderId] : []))])];
  if (tiktokOrderIds.length > 0) {
    await testDb.delete(tiktokOrders).where(inArray(tiktokOrders.tiktokOrderId, tiktokOrderIds));
    await testDb.delete(tiktokOrderSnapshots).where(inArray(tiktokOrderSnapshots.tiktokOrderId, tiktokOrderIds));
    await testDb.delete(tiktokSkuMappings).where(inArray(tiktokSkuMappings.variantSku, [fixture.skuA, fixture.skuB]));
  }
  await withTriggerDisabled(testDb, "stock_movements", "prevent_stock_movement_mutation", () => testDb.delete(stockMovements).where(inArray(stockMovements.sku, [fixture.skuA, fixture.skuB])));
  if (orderIds.length > 0) {
    await testDb.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
    await testDb.delete(orders).where(inArray(orders.id, orderIds));
  }
  await testDb.delete(productVariants).where(inArray(productVariants.sku, [fixture.skuA, fixture.skuB]));
  await testDb.delete(products).where(inArray(products.id, fixture.cleanup.productIds));
  await testDb.delete(fabricColors).where(eq(fabricColors.id, fixture.cleanup.colorId));
  await testDb.delete(fabrics).where(eq(fabrics.id, fixture.cleanup.fabricId));
}

describe("applyTikTokOrder: concurrency", () => {
  test("the webhook drain and the poll apply the same order at once → one order, one set of movements", async () => {
    const fixture = await catalog(testDb);
    const id = newTikTokId();
    try {
      await map(testDb, `tt-a-${id}`, fixture.skuA);
      await map(testDb, `tt-b-${id}`, fixture.skuB);
      await ingest(testDb, rawOrder(id, BASE), BASE);
      const results = await Promise.all([applyTikTokOrder(testDb, id, { now: BASE, source: "webhook" }), applyTikTokOrder(testDb, id, { now: BASE, source: "poll" })]);
      expect(results.map((result) => result.kind).sort()).toEqual(["created", "unchanged"]);
      const admin = await adminOrder(testDb, id);
      expect(admin).toHaveLength(1);
      expect(await movementsOf(testDb, admin[0]!.id)).toHaveLength(2);
      expect(await balance(testDb, fixture.skuA)).toBe(4);
    } finally {
      await cleanup(fixture, [id]);
    }
  });

  test("a TikTok order racing a manual order for the last unit: exactly one gets it, stock never negative", async () => {
    const fixture = await catalog(testDb, 1, 5);
    const id = newTikTokId();
    const staff = await insertStaffUser(testDb);
    let manualOrderId: string | null = null;
    try {
      await map(testDb, `tt-a-${id}`, fixture.skuA);
      await map(testDb, `tt-b-${id}`, fixture.skuB);
      await ingest(testDb, rawOrder(id, BASE), BASE);
      const [tiktok, manual] = await Promise.allSettled([
        applyTikTokOrder(testDb, id, { now: BASE, source: "poll" }),
        createOrder({ channelId: "whatsapp", orderDate: "2026-12-02", items: [{ sku: fixture.skuA, qty: 1, unitPrice: 259_000 }], discountAmount: 0, shippingAmount: 0, status: "to_ship" }, staff.id, testDb),
      ]);
      if (manual.status === "fulfilled") manualOrderId = manual.value!.id;
      expect(tiktok.status).toBe("fulfilled");
      const tiktokKind = tiktok.status === "fulfilled" ? tiktok.value.kind : null;
      // Exactly one sale of the last piece.
      expect([tiktokKind === "created", manual.status === "fulfilled"].filter(Boolean)).toHaveLength(1);
      if (tiktokKind !== "created") expect(tiktok.status === "fulfilled" && tiktok.value).toMatchObject({ kind: "held", reason: "short_stock" });
      expect(await balance(testDb, fixture.skuA)).toBe(0);
      // Only SKU B of the TikTok order may have left, and only if the TikTok order won.
      expect(await balance(testDb, fixture.skuB)).toBe(tiktokKind === "created" ? 4 : 5);
    } finally {
      await cleanup(fixture, [id], manualOrderId ? [manualOrderId] : []);
    }
  });
});

