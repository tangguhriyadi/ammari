import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  auditLog,
  fabricColors,
  fabrics,
  marketplaceRefunds,
  orderItems,
  orders,
  products,
  productVariants,
  stockMovements,
  tiktokOrderSnapshots,
  tiktokOrders,
  tiktokReturns,
  tiktokSkuMappings,
} from "@ammari/db/schema";
import { insertProductVariant, insertStaffUser, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { projectTikTokAfterSale, projectTikTokOrder, type TikTokAfterSaleKind } from "@ammari/tiktok-shop";
import { ActionError } from "../errors";
import { clearAttentionFlag } from "../payments/staff";
import { currentBalanceForSkuLocked } from "../stock/ledger";
import { applyTikTokAfterSale, ingestTikTokAfterSale, listTikTokAfterSalesToApply, receiveMarketplaceReturn } from "./after-sale";
import { TIKTOK_RESPONSE_WINDOW_MS } from "./after-sale-rules";
import { applyTikTokOrder } from "./apply";
import { ingestTikTokOrder } from "./order-store";

// docs/plans/tiktok-shop-integration.md T6 against a real database: requests stored and applied to
// the admin order. Stock comes back only through "Retur diterima" (Q11, Q18); refund-only writes one
// marketplace_refunds row and nothing else (Q10). Every test rolls back except the concurrency test.

const HOUR = 3_600_000;
const BASE = new Date("2026-12-02T03:00:00.000Z");
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

let counter = 0;
function newId(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now()}`.slice(0, 15) + String(counter).padStart(3, "0");
}

async function catalog(db: TestDatabase) {
  const { fabric, color, product, variant } = await insertProductVariant(db);
  const second = await insertVariantForProduct(db, fabric.id, color.id, {}, "L");
  await db.insert(stockMovements).values([
    { sku: variant.sku, qty: 5, valueAmount: 500_000, type: "production", refType: "manual" },
    { sku: second.variant.sku, qty: 5, valueAmount: 450_000, type: "production", refType: "manual" },
  ]);
  return { skuA: variant.sku, skuB: second.variant.sku, cleanup: { fabricId: fabric.id, colorId: color.id, productIds: [product.id, second.product.id] } };
}

function rawOrder(id: string, status: string, updateTime: Date, extra: Record<string, unknown> = {}) {
  return {
    id,
    status,
    create_time: seconds(updateTime) - 30 * 3600,
    update_time: seconds(updateTime),
    paid_time: seconds(updateTime) - 30 * 3600,
    collection_time: status === "AWAITING_SHIPMENT" ? undefined : seconds(updateTime) - 20 * 3600,
    is_on_hold_order: false,
    payment: { currency: "IDR", sub_total: "500000", seller_discount: "20000", platform_discount: "0", total_amount: "480000" },
    line_items: [
      { id: `${id}-1`, sku_id: `tt-a-${id}`, original_price: "259000", seller_discount: "10000" },
      { id: `${id}-2`, sku_id: `tt-b-${id}`, original_price: "241000", seller_discount: "0" },
    ],
    ...extra,
  };
}

async function setup(db: TestDatabase, status = "IN_TRANSIT") {
  const fixture = await catalog(db);
  const id = newId("5771");
  await db.insert(tiktokSkuMappings).values([
    { tiktokSkuId: `tt-a-${id}`, variantSku: fixture.skuA, source: "auto_seller_sku", sellerSku: fixture.skuA },
    { tiktokSkuId: `tt-b-${id}`, variantSku: fixture.skuB, source: "auto_seller_sku", sellerSku: fixture.skuB },
  ]);
  await order(db, id, status, BASE);
  const [admin] = await db.select().from(orders).where(and(eq(orders.channelId, "tiktok"), eq(orders.channelOrderNo, id)));
  if (!admin) throw new Error("order not applied");
  return { ...fixture, id, orderId: admin.id };
}

async function order(db: TestDatabase, id: string, status: string, at: Date, extra: Record<string, unknown> = {}) {
  const projected = projectTikTokOrder(rawOrder(id, status, at, extra));
  if (!projected.ok) throw new Error("projection failed");
  await ingestTikTokOrder(db, projected.order, "poll", at);
  return applyTikTokOrder(db, id, { now: at, source: "poll" });
}

function rawReturn(orderId: string, requestId: string, at: Date, extra: Record<string, unknown> = {}) {
  return {
    return_id: requestId,
    order_id: orderId,
    return_type: "RETURN_AND_REFUND",
    return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
    create_time: seconds(at) - 60,
    update_time: seconds(at),
    refund_amount: { currency: "IDR", refund_total: "480000" },
    return_line_items: [{ order_line_item_id: `${orderId}-1` }, { order_line_item_id: `${orderId}-2` }],
    ...extra,
  };
}

async function request(db: TestDatabase, kind: TikTokAfterSaleKind, raw: Record<string, unknown>, at: Date) {
  const projected = projectTikTokAfterSale(kind, raw);
  if (!projected.ok) throw new Error("projection failed");
  const stored = await ingestTikTokAfterSale(db, projected.record, "poll", at);
  const applied = await applyTikTokAfterSale(db, kind, projected.record.requestId, { now: at, source: "poll" });
  return { stored, applied };
}

async function adminOrder(db: TestDatabase, orderId: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
  return row!;
}

async function balance(db: TestDatabase, sku: string) {
  return (await currentBalanceForSkuLocked(db as never, sku)).qty;
}

async function movementsOf(db: TestDatabase, orderId: string) {
  const items = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId));
  return db
    .select({ type: stockMovements.type, qty: stockMovements.qty, sku: stockMovements.sku, valueAmount: stockMovements.valueAmount })
    .from(stockMovements)
    .where(and(eq(stockMovements.refType, "order_item"), inArray(stockMovements.refId, items.map((item) => item.id))));
}

async function refundsOf(db: TestDatabase, orderId: string) {
  return db.select().from(marketplaceRefunds).where(eq(marketplaceRefunds.orderId, orderId));
}

async function actionsOf(db: TestDatabase, entityId: string) {
  return (await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, entityId))).map((row) => row.action);
}

describe("failed delivery (Q11): stock waits for the parcel", () => {
  test("TikTok cancels after shipping → flags only, stock unchanged; Retur diterima → exact-negation return, flags cleared", async () => {
    await withRollback(async (tx) => {
      const { id, orderId, skuA, skuB } = await setup(tx);
      expect(await balance(tx, skuA)).toBe(4);
      await order(tx, id, "CANCELLED", new Date(BASE.getTime() + HOUR), { cancel_time: seconds(BASE) + 3600 });
      const flagged = await adminOrder(tx, orderId);
      expect(flagged.status).toBe("shipped");
      expect(flagged.needsAttention).toEqual(expect.arrayContaining(["marketplace_return_pending", "marketplace_return_in_transit"]));
      expect(await balance(tx, skuA)).toBe(4);
      expect(await movementsOf(tx, orderId)).toHaveLength(2);

      const staff = await insertStaffUser(tx);
      await receiveMarketplaceReturn(tx, orderId, staff.id);
      const returned = await adminOrder(tx, orderId);
      expect(returned.status).toBe("returned");
      expect(returned.needsAttention).not.toContain("marketplace_return_pending");
      expect(returned.needsAttention).not.toContain("marketplace_return_in_transit");
      const movements = await movementsOf(tx, orderId);
      const sales = movements.filter((movement) => movement.type === "sale");
      const back = movements.filter((movement) => movement.type !== "sale");
      expect(back).toHaveLength(2);
      for (const sale of sales) expect(back).toContainEqual(expect.objectContaining({ sku: sale.sku, qty: -sale.qty, valueAmount: -sale.valueAmount }));
      expect(await balance(tx, skuA)).toBe(5);
      expect(await balance(tx, skuB)).toBe(5);
      expect(await actionsOf(tx, orderId)).toContain("marketplace_return_received");
    });
  });

  test("Retur diterima is refused without the in-transit flag, and changes nothing", async () => {
    await withRollback(async (tx) => {
      const { orderId, skuA } = await setup(tx);
      const staff = await insertStaffUser(tx);
      await expect(receiveMarketplaceReturn(tx, orderId, staff.id)).rejects.toBeInstanceOf(ActionError);
      expect((await adminOrder(tx, orderId)).status).toBe("shipped");
      expect(await balance(tx, skuA)).toBe(4);
    });
  });

  test("the in-transit flag cannot be cleared by Tandai beres (only by the received return)", async () => {
    await withRollback(async (tx) => {
      const { id, orderId } = await setup(tx);
      await order(tx, id, "CANCELLED", new Date(BASE.getTime() + HOUR), { cancel_time: seconds(BASE) + 3600 });
      const staff = await insertStaffUser(tx);
      await expect(clearAttentionFlag(tx, orderId, "marketplace_return_in_transit", staff.id)).rejects.toBeInstanceOf(ActionError);
    });
  });
});

describe("return with goods (Q18)", () => {
  test("open → pending + response due; buyer ships → in transit; complete → returned_at, stock still out; Retur diterima puts it back", async () => {
    await withRollback(async (tx) => {
      const { id, orderId, skuA } = await setup(tx, "DELIVERED");
      const rid = newId("4035");
      const t1 = new Date(BASE.getTime() + HOUR);
      const first = await request(tx, "return", rawReturn(id, rid, t1), t1);
      expect(first.applied).toMatchObject({ kind: "applied", state: "open" });
      let row = await adminOrder(tx, orderId);
      expect(row.needsAttention).toEqual(expect.arrayContaining(["marketplace_return_pending", "tiktok_return_response_due"]));
      expect(row.needsAttention).not.toContain("marketplace_return_in_transit");
      const [stored] = await tx.select().from(tiktokReturns).where(eq(tiktokReturns.requestId, rid));
      expect(stored!.responseDueAt?.getTime()).toBe((seconds(t1) - 60) * 1000 + TIKTOK_RESPONSE_WINDOW_MS);

      const t2 = new Date(t1.getTime() + HOUR);
      await request(tx, "return", rawReturn(id, rid, t2, { return_status: "BUYER_SHIPPED_ITEM" }), t2);
      row = await adminOrder(tx, orderId);
      expect(row.needsAttention).toEqual(expect.arrayContaining(["marketplace_return_pending", "marketplace_return_in_transit"]));
      expect(row.needsAttention).not.toContain("tiktok_return_response_due");

      const t3 = new Date(t2.getTime() + HOUR);
      await request(tx, "return", rawReturn(id, rid, t3, { return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE" }), t3);
      row = await adminOrder(tx, orderId);
      expect(row.status).toBe("shipped");
      expect(row.marketplaceReturnedAt?.getTime()).toBe(seconds(t3) * 1000);
      expect(await balance(tx, skuA)).toBe(4);
      expect(await refundsOf(tx, orderId)).toHaveLength(0);

      const staff = await insertStaffUser(tx);
      await receiveMarketplaceReturn(tx, orderId, staff.id);
      expect((await adminOrder(tx, orderId)).status).toBe("returned");
      expect(await balance(tx, skuA)).toBe(5);
      expect(await actionsOf(tx, orderId)).toContain("tiktok_return_update");
    });
  });

  test("a refund in transit on a COMPLETED order follows the same path (with goods: waits for receipt)", async () => {
    await withRollback(async (tx) => {
      const { id, orderId, skuA } = await setup(tx, "COMPLETED");
      expect((await adminOrder(tx, orderId)).status).toBe("completed");
      const rid = newId("4035");
      const t = new Date(BASE.getTime() + HOUR);
      const result = await request(tx, "return", rawReturn(id, rid, t, { return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE" }), t);
      expect(result.applied).toMatchObject({ state: "completed_goods" });
      const row = await adminOrder(tx, orderId);
      expect(row.status).toBe("completed");
      expect(row.needsAttention).toEqual(expect.arrayContaining(["marketplace_return_pending", "marketplace_return_in_transit"]));
      expect(await balance(tx, skuA)).toBe(4);
    });
  });

  test("a partial return with goods → marketplace_partial_return only, nothing moves", async () => {
    await withRollback(async (tx) => {
      const { id, orderId, skuA } = await setup(tx, "DELIVERED");
      const t = new Date(BASE.getTime() + HOUR);
      await request(tx, "return", rawReturn(id, newId("4035"), t, { return_status: "BUYER_SHIPPED_ITEM", return_line_items: [{ order_line_item_id: `${id}-1` }] }), t);
      const row = await adminOrder(tx, orderId);
      expect(row.needsAttention).toContain("marketplace_partial_return");
      expect(row.needsAttention).not.toContain("marketplace_return_in_transit");
      expect(row.status).toBe("shipped");
      expect(await balance(tx, skuA)).toBe(4);
    });
  });

  test("a replacement (not classifiable) → marketplace_review, nothing else", async () => {
    await withRollback(async (tx) => {
      const { id, orderId } = await setup(tx, "DELIVERED");
      const t = new Date(BASE.getTime() + HOUR);
      const result = await request(tx, "return", rawReturn(id, newId("4035"), t, { return_type: "REPLACEMENT" }), t);
      expect(result.applied).toMatchObject({ state: "review" });
      const [stored] = await tx.select().from(tiktokReturns).where(eq(tiktokReturns.tiktokOrderId, id));
      expect(stored!.reviewReason).toBe("replacement");
      expect((await adminOrder(tx, orderId)).needsAttention).toContain("marketplace_review");
    });
  });
});

describe("refund-only (Q10)", () => {
  test("complete → one refund row, no stock movement, status unchanged, pending cleared", async () => {
    await withRollback(async (tx) => {
      const { id, orderId, skuA } = await setup(tx, "DELIVERED");
      const rid = newId("4035");
      const t1 = new Date(BASE.getTime() + HOUR);
      await request(tx, "return", rawReturn(id, rid, t1, { return_type: "REFUND" }), t1);
      expect((await adminOrder(tx, orderId)).needsAttention).toContain("marketplace_return_pending");
      const movementsBefore = await movementsOf(tx, orderId);

      const t2 = new Date(t1.getTime() + HOUR);
      const done = await request(tx, "return", rawReturn(id, rid, t2, { return_type: "REFUND", return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE", refund_amount: { refund_total: "100000" } }), t2);
      expect(done.applied).toMatchObject({ state: "completed_refund", refundRecorded: true });
      const refunds = await refundsOf(tx, orderId);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ channelId: "tiktok", channelRefundId: rid, kind: "refund_only", amount: 100_000 });
      expect(refunds[0]!.refundedAt.getTime()).toBe(seconds(t2) * 1000);
      const row = await adminOrder(tx, orderId);
      expect(row.status).toBe("shipped");
      expect(row.marketplaceReturnedAt).toBeNull();
      expect(row.needsAttention).not.toContain("marketplace_return_pending");
      expect(await movementsOf(tx, orderId)).toEqual(movementsBefore);
      expect(await balance(tx, skuA)).toBe(4);
      expect(await actionsOf(tx, orderId)).toContain("tiktok_refund_record");
    });
  });

  test("a replayed refund → still one row; repeated snapshots are idempotent (no new snapshot, no new audit)", async () => {
    await withRollback(async (tx) => {
      const { id, orderId } = await setup(tx, "DELIVERED");
      const rid = newId("4035");
      const t = new Date(BASE.getTime() + HOUR);
      const raw = rawReturn(id, rid, t, { return_type: "REFUND", return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE", refund_amount: { refund_total: "100000" } });
      await request(tx, "return", raw, t);
      const auditsBefore = (await actionsOf(tx, orderId)).length;
      const again = await request(tx, "return", raw, new Date(t.getTime() + HOUR));
      expect(again.stored).toEqual({ snapshot: "replay", projection: "unchanged" });
      expect(again.applied).toMatchObject({ kind: "unchanged" });
      expect(await refundsOf(tx, orderId)).toHaveLength(1);
      expect((await actionsOf(tx, orderId)).length).toBe(auditsBefore);
      const snapshots = await tx.select({ id: tiktokOrderSnapshots.id }).from(tiktokOrderSnapshots).where(and(eq(tiktokOrderSnapshots.tiktokOrderId, id), eq(tiktokOrderSnapshots.kind, "return")));
      expect(snapshots).toHaveLength(1);

      // A later version of the completed request (TikTok touched it) never writes a second row.
      const later = new Date(t.getTime() + 2 * HOUR);
      await request(tx, "return", { ...raw, update_time: seconds(later) }, later);
      expect(await refundsOf(tx, orderId)).toHaveLength(1);
    });
  });

  test("a refund above the order total → review, no row", async () => {
    await withRollback(async (tx) => {
      const { id, orderId } = await setup(tx, "DELIVERED");
      const t = new Date(BASE.getTime() + HOUR);
      const result = await request(tx, "return", rawReturn(id, newId("4035"), t, { return_type: "REFUND", return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE", refund_amount: { refund_total: "999999" } }), t);
      expect(result.applied).toMatchObject({ state: "review" });
      expect(await refundsOf(tx, orderId)).toHaveLength(0);
      expect((await adminOrder(tx, orderId)).needsAttention).toContain("marketplace_review");
    });
  });
});

describe("review fixes: decisions that depended on the admin order, refunds per order, versions out of order", () => {
  test("a return decided while admin had not shipped yet is decided again once the order ships", async () => {
    await withRollback(async (tx) => {
      const { id, orderId } = await setup(tx, "AWAITING_SHIPMENT");
      const rid = newId("4035");
      const t1 = new Date(BASE.getTime() + HOUR);
      const first = await request(tx, "return", rawReturn(id, rid, t1, { return_type: "REFUND", return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE", refund_amount: { refund_total: "100000" } }), t1);
      expect(first.applied).toMatchObject({ state: "review" });
      expect(await refundsOf(tx, orderId)).toHaveLength(0);
      await order(tx, id, "DELIVERED", new Date(t1.getTime() + HOUR));
      expect((await adminOrder(tx, orderId)).status).toBe("shipped");
      const later = new Date(t1.getTime() + 2 * HOUR);
      expect((await listTikTokAfterSalesToApply(tx, later)).items).toContainEqual({ kind: "return", requestId: rid });
      const again = await applyTikTokAfterSale(tx, "return", rid, { now: later, source: "recheck" });
      expect(again).toMatchObject({ kind: "applied", state: "completed_refund", refundRecorded: true });
      expect(await refundsOf(tx, orderId)).toHaveLength(1);
    });
  });

  test("two refund-only requests may not together exceed the order total", async () => {
    await withRollback(async (tx) => {
      const { id, orderId } = await setup(tx, "DELIVERED");
      const t = new Date(BASE.getTime() + HOUR);
      const done = (rid: string, total: string) => rawReturn(id, rid, t, { return_type: "REFUND", return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE", refund_amount: { refund_total: total } });
      expect((await request(tx, "return", done(newId("4035"), "300000"), t)).applied).toMatchObject({ state: "completed_refund" });
      expect((await request(tx, "return", done(newId("4035"), "200000"), t)).applied).toMatchObject({ state: "review" });
      const refunds = await refundsOf(tx, orderId);
      expect(refunds.map((refund) => refund.amount)).toEqual([300_000]);
    });
  });

  test("a COMPLETE version arriving after a newer one still dates the return", async () => {
    await withRollback(async (tx) => {
      const { id } = await setup(tx, "DELIVERED");
      const rid = newId("4035");
      const complete = new Date(BASE.getTime() + HOUR);
      const newer = new Date(complete.getTime() + HOUR);
      await request(tx, "return", rawReturn(id, rid, newer, { return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE", arbitration_status: "CLOSED" }), newer);
      await request(tx, "return", rawReturn(id, rid, complete, { return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE" }), newer);
      const [stored] = await tx.select().from(tiktokReturns).where(eq(tiktokReturns.requestId, rid));
      expect(stored!.completedAt?.getTime()).toBe(seconds(complete) * 1000);
    });
  });

  test("a request TikTok later names under another order is never re-pointed", async () => {
    await withRollback(async (tx) => {
      const { id } = await setup(tx, "DELIVERED");
      const rid = newId("4035");
      const t = new Date(BASE.getTime() + HOUR);
      await request(tx, "return", rawReturn(id, rid, t), t);
      const projected = projectTikTokAfterSale("return", rawReturn("5779999999999999", rid, new Date(t.getTime() + HOUR)));
      if (!projected.ok) throw new Error("projection failed");
      expect(await ingestTikTokAfterSale(tx, projected.record, "poll", t)).toEqual({ snapshot: "order_mismatch", projection: "unchanged" });
      const [stored] = await tx.select().from(tiktokReturns).where(eq(tiktokReturns.requestId, rid));
      expect(stored!.tiktokOrderId).toBe(id);
    });
  });
});

describe("cancellations and the response deadline", () => {
  test("a pending cancellation request → response due; the deadline passing → the re-check clears it", async () => {
    await withRollback(async (tx) => {
      const { id, orderId } = await setup(tx, "AWAITING_SHIPMENT");
      const cid = newId("4036");
      const t = new Date(BASE.getTime() + HOUR);
      const deadline = seconds(t) + 3600;
      await request(tx, "cancellation", { cancel_id: cid, order_id: id, cancel_type: "BUYER_CANCEL", cancel_status: "CANCELLATION_REQUEST_PENDING", create_time: seconds(t), update_time: seconds(t), seller_next_action_response: [{ action: "RESPOND", deadline }] }, t);
      const row = await adminOrder(tx, orderId);
      expect(row.needsAttention).toContain("tiktok_return_response_due");
      expect(row.needsAttention).not.toContain("marketplace_return_pending");

      const after = new Date((deadline + 60) * 1000);
      const due = await listTikTokAfterSalesToApply(tx, after);
      expect(due.items).toContainEqual({ kind: "cancellation", requestId: cid });
      const result = await applyTikTokAfterSale(tx, "cancellation", cid, { now: after, source: "recheck" });
      expect(result).toMatchObject({ kind: "applied", changed: true });
      expect((await adminOrder(tx, orderId)).needsAttention).not.toContain("tiktok_return_response_due");
      expect((await listTikTokAfterSalesToApply(tx, after)).items).not.toContainEqual({ kind: "cancellation", requestId: cid });
    });
  });

  test("a request for an order not in admin yet waits, then applies once the order is", async () => {
    await withRollback(async (tx) => {
      const fixture = await catalog(tx);
      const id = newId("5771");
      const rid = newId("4035");
      // The order is stored but not applied (no mapping yet → held).
      const projected = projectTikTokOrder(rawOrder(id, "DELIVERED", BASE));
      if (!projected.ok) throw new Error("projection failed");
      await ingestTikTokOrder(tx, projected.order, "poll", BASE);
      const t = new Date(BASE.getTime() + HOUR);
      const first = await request(tx, "return", rawReturn(id, rid, t), t);
      expect(first.applied).toMatchObject({ state: "waiting_order", orderId: null });

      await tx.insert(tiktokSkuMappings).values([
        { tiktokSkuId: `tt-a-${id}`, variantSku: fixture.skuA, source: "auto_seller_sku", sellerSku: fixture.skuA },
        { tiktokSkuId: `tt-b-${id}`, variantSku: fixture.skuB, source: "auto_seller_sku", sellerSku: fixture.skuB },
      ]);
      await applyTikTokOrder(tx, id, { now: t, source: "recheck" });
      const later = new Date(t.getTime() + HOUR);
      expect((await listTikTokAfterSalesToApply(tx, later)).items).toContainEqual({ kind: "return", requestId: rid });
      const applied = await applyTikTokAfterSale(tx, "return", rid, { now: later, source: "recheck" });
      expect(applied).toMatchObject({ kind: "applied", state: "open" });
      const [admin] = await tx.select().from(orders).where(and(eq(orders.channelId, "tiktok"), eq(orders.channelOrderNo, id)));
      expect(admin!.needsAttention).toContain("marketplace_return_pending");
    });
  });

  test("an older version arriving late never moves the request back", async () => {
    await withRollback(async (tx) => {
      const { id } = await setup(tx, "DELIVERED");
      const rid = newId("4035");
      const t1 = new Date(BASE.getTime() + HOUR);
      const t2 = new Date(t1.getTime() + HOUR);
      await request(tx, "return", rawReturn(id, rid, t2, { return_status: "BUYER_SHIPPED_ITEM" }), t2);
      const late = await request(tx, "return", rawReturn(id, rid, t1), t2);
      expect(late.stored.projection).toBe("unchanged");
      const [stored] = await tx.select().from(tiktokReturns).where(eq(tiktokReturns.requestId, rid));
      expect(stored).toMatchObject({ status: "BUYER_SHIPPED_ITEM", state: "goods_coming" });
    });
  });
});

describe("concurrency", () => {
  test("the webhook drain and the poll apply the same completed refund at once → one refund row", async () => {
    const fixture = await catalog(testDb);
    const id = newId("5771");
    const rid = newId("4035");
    let orderId: string | null = null;
    try {
      await testDb.insert(tiktokSkuMappings).values([
        { tiktokSkuId: `tt-a-${id}`, variantSku: fixture.skuA, source: "auto_seller_sku", sellerSku: fixture.skuA },
        { tiktokSkuId: `tt-b-${id}`, variantSku: fixture.skuB, source: "auto_seller_sku", sellerSku: fixture.skuB },
      ]);
      await order(testDb, id, "DELIVERED", BASE);
      const [admin] = await testDb.select().from(orders).where(and(eq(orders.channelId, "tiktok"), eq(orders.channelOrderNo, id)));
      orderId = admin!.id;
      const t = new Date(BASE.getTime() + HOUR);
      const projected = projectTikTokAfterSale("return", rawReturn(id, rid, t, { return_type: "REFUND", return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE", refund_amount: { refund_total: "100000" } }));
      if (!projected.ok) throw new Error("projection failed");
      await Promise.all([ingestTikTokAfterSale(testDb, projected.record, "webhook", t), ingestTikTokAfterSale(testDb, projected.record, "poll", t)]);
      const results = await Promise.all([applyTikTokAfterSale(testDb, "return", rid, { now: t, source: "webhook" }), applyTikTokAfterSale(testDb, "return", rid, { now: t, source: "poll" })]);
      expect(results.map((result) => result.kind).sort()).toEqual(["applied", "unchanged"]);
      expect(await refundsOf(testDb, orderId)).toHaveLength(1);
    } finally {
      await testDb.delete(tiktokReturns).where(eq(tiktokReturns.tiktokOrderId, id));
      if (orderId) await testDb.delete(marketplaceRefunds).where(eq(marketplaceRefunds.orderId, orderId));
      await testDb.delete(tiktokOrders).where(eq(tiktokOrders.tiktokOrderId, id));
      await testDb.delete(tiktokOrderSnapshots).where(eq(tiktokOrderSnapshots.tiktokOrderId, id));
      await testDb.delete(tiktokSkuMappings).where(inArray(tiktokSkuMappings.variantSku, [fixture.skuA, fixture.skuB]));
      await withTriggerDisabled(testDb, "stock_movements", "prevent_stock_movement_mutation", () => testDb.delete(stockMovements).where(inArray(stockMovements.sku, [fixture.skuA, fixture.skuB])));
      if (orderId) {
        await testDb.delete(orderItems).where(eq(orderItems.orderId, orderId));
        await testDb.delete(orders).where(eq(orders.id, orderId));
      }
      await testDb.delete(productVariants).where(inArray(productVariants.sku, [fixture.skuA, fixture.skuB]));
      await testDb.delete(products).where(inArray(products.id, fixture.cleanup.productIds));
      await testDb.delete(fabricColors).where(eq(fabricColors.id, fixture.cleanup.colorId));
      await testDb.delete(fabrics).where(eq(fabrics.id, fixture.cleanup.fabricId));
    }
  });
});
