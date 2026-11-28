import { and, eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { auditLog, orderItems, productVariants, stockMovements, stockReservations, tiktokListingSkus, tiktokOrderSnapshots, tiktokOrders, tiktokShopConnections, tiktokSkuMappings, tiktokSyncCursors } from "@ammari/db/schema";
import { insertOrder, insertProductVariant, insertStaffUser, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { Secret, createTikTokClient, type FetchLike, type TikTokAuthClient, type TikTokListingProductRecord, type TokenKeyring } from "@ammari/tiktok-shop";
import { setTikTokOrdersApply } from "./apply";
import { saveTikTokConnection } from "./connection";
import { finishTikTokListingPass, getTikTokStockSyncPreview, setTikTokStockSync, storeTikTokListingProduct, tiktokStockSyncEnabled } from "./stock-sync";
import { TIKTOK_LISTINGS_EVERY_MS, runTikTokSync } from "./sync";

// docs/plans/tiktok-stock-sync.md S1 against a real database (every test rolls back): the listing store
// (idempotent upsert, exact auto-map, holds, not_listed only after a complete pass, several listings),
// the switch and rule R1, the preview's target (decision 1, R2), and the read pass inside the sync run
// with an in-memory TikTok that answers reads only. No test expects anything to be pushed: S1 has no
// write call at all, and the fake refuses every path but the reads.

const NOW = new Date("2026-12-02T03:00:00.000Z");
const DAY = 86_400_000;
const MIN = 60_000;
const KEYRING: TokenKeyring = { currentVersion: 1, keys: new Map([[1, new Secret(new Uint8Array(32).fill(7))]]) };
const OWN = new Set(["wh-own"]);
const ALL_SCOPES = ["seller.order.info", "seller.product.basic", "seller.logistics", "seller.product.write"];

async function connect(db: TestDatabase, scopes = ALL_SCOPES): Promise<{ connectionId: string; staffId: string }> {
  const staff = await insertStaffUser(db);
  const result = await saveTikTokConnection(db, {
    tokens: {
      accessToken: new Secret("ROW_access_stock"),
      accessTokenExpiresAt: new Date(NOW.getTime() + 7 * DAY),
      refreshToken: new Secret("ROW_refresh_stock"),
      refreshTokenExpiresAt: new Date(NOW.getTime() + 60 * DAY),
      grantedScopes: scopes,
      sellerName: "Ammari",
      sellerBaseRegion: "ID",
    },
    shop: { shopId: "7495540735365777999", shopCipher: "ROW_cipher", shopName: "Ammari", region: "ID", sellerType: "LOCAL" },
    staffUserId: staff.id,
    keyring: KEYRING,
    now: new Date(NOW.getTime() - DAY),
  });
  if (!result.ok) throw new Error(result.reason);
  return { connectionId: result.connectionId, staffId: staff.id };
}

/** Two variants of one product with stock (A: 6, B: 3). */
async function catalog(db: TestDatabase) {
  const { fabric, color, variant } = await insertProductVariant(db);
  const second = await insertVariantForProduct(db, fabric.id, color.id, {}, "L");
  // Ammari SKUs are uppercase (Daftar SKU); the fixtures' carry a lowercase uuid.
  const skuA = variant.sku.toUpperCase();
  const skuB = second.variant.sku.toUpperCase();
  await db.update(productVariants).set({ sku: skuA }).where(eq(productVariants.sku, variant.sku));
  await db.update(productVariants).set({ sku: skuB }).where(eq(productVariants.sku, second.variant.sku));
  await db.insert(stockMovements).values([
    { sku: skuA, qty: 6, valueAmount: 600_000, type: "production", refType: "manual" },
    { sku: skuB, qty: 3, valueAmount: 270_000, type: "production", refType: "manual" },
  ]);
  return { skuA, skuB };
}

function product(productId: string, skus: { id: string; sellerSku: string | null; inventory?: unknown }[], status = "ACTIVATE", skuCount?: number): TikTokListingProductRecord {
  return {
    productId,
    status,
    title: `Gamis ${productId}`,
    skus: skus.map((sku) => ({ skuId: sku.id, sellerSku: sku.sellerSku, label: "Hitam · M", inventory: (sku.inventory ?? [{ warehouse_id: "wh-own", quantity: 2 }]) as never })),
    skuCount: skuCount ?? skus.length,
    invalidSkus: 0,
  };
}

async function listing(db: TestDatabase, skuId: string) {
  const [row] = await db.select().from(tiktokListingSkus).where(eq(tiktokListingSkus.tiktokSkuId, skuId));
  return row;
}

async function store(db: TestDatabase, connectionId: string, record: TikTokListingProductRecord, readAt = NOW) {
  return storeTikTokListingProduct(db, { connectionId, product: record, ownWarehouses: OWN, readAt });
}

describe("storeTikTokListingProduct / finishTikTokListingPass", () => {
  test("exact seller-SKU auto-map (trimmed, uppercase), audited; a near miss stays unmapped", async () => {
    await withRollback(async (tx) => {
      const { connectionId } = await connect(tx);
      const { skuA } = await catalog(tx);
      const result = await store(tx, connectionId, product("p1", [{ id: "s-a", sellerSku: `  ${skuA.toLowerCase()} ` }, { id: "s-near", sellerSku: `${skuA}X` }]));
      expect(result.autoMapped).toEqual(["s-a"]);
      expect(await listing(tx, "s-a")).toMatchObject({ variantSku: skuA, holdReason: null, warehouseId: "wh-own", tiktokQuantity: 2, productStatus: "ACTIVATE", productTitle: "Gamis p1" });
      expect(await listing(tx, "s-near")).toMatchObject({ variantSku: null, holdReason: "unmapped" });
      const [mapping] = await tx.select().from(tiktokSkuMappings).where(eq(tiktokSkuMappings.tiktokSkuId, "s-a"));
      expect(mapping).toMatchObject({ variantSku: skuA, source: "auto_seller_sku", tiktokProductId: "p1" });
      const audits = await tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, "s-a"));
      expect(audits.map((a) => a.action)).toEqual(["tiktok_sku_auto_map"]);
    });
  });

  test("a mapping a person removed is never re-created by the read; a manual mapping wins over the seller SKU", async () => {
    await withRollback(async (tx) => {
      const { connectionId, staffId } = await connect(tx);
      const { skuA, skuB } = await catalog(tx);
      await tx.insert(tiktokSkuMappings).values([
        { tiktokSkuId: "s-removed", variantSku: skuA, source: "auto_seller_sku", isActive: false },
        { tiktokSkuId: "s-manual", variantSku: skuB, source: "manual", mappedByStaffUserId: staffId },
      ]);
      await store(tx, connectionId, product("p1", [{ id: "s-removed", sellerSku: skuA }, { id: "s-manual", sellerSku: skuA }]));
      expect(await listing(tx, "s-removed")).toMatchObject({ variantSku: null, holdReason: "unmapped" });
      expect(await listing(tx, "s-manual")).toMatchObject({ variantSku: skuB, holdReason: null });
    });
  });

  test("upsert is idempotent: the same read twice → one row per SKU, same values; S2's push columns are never touched", async () => {
    await withRollback(async (tx) => {
      const { connectionId } = await connect(tx);
      const { skuA } = await catalog(tx);
      const record = product("p1", [{ id: "s-a", sellerSku: skuA }]);
      await store(tx, connectionId, record);
      const first = await listing(tx, "s-a");
      await tx.update(tiktokListingSkus).set({ lastPushedQuantity: 4, lastPushedAt: NOW }).where(eq(tiktokListingSkus.tiktokSkuId, "s-a"));
      const later = new Date(NOW.getTime() + 15 * MIN);
      await store(tx, connectionId, record, later);
      const rows = await tx.select().from(tiktokListingSkus).where(eq(tiktokListingSkus.connectionId, connectionId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ variantSku: skuA, tiktokQuantity: 2, holdReason: null, lastPushedQuantity: 4, readAt: later, firstSeenAt: first!.firstSeenAt });
      const mappings = await tx.select().from(tiktokSkuMappings).where(eq(tiktokSkuMappings.tiktokSkuId, "s-a"));
      expect(mappings).toHaveLength(1);
    });
  });

  test("holds: status not updatable, warehouse unclear (FBT only / two own), unreadable quantity, more than 100 SKUs", async () => {
    await withRollback(async (tx) => {
      const { connectionId } = await connect(tx);
      const { skuA, skuB } = await catalog(tx);
      await store(tx, connectionId, product("p-frozen", [{ id: "s-frozen", sellerSku: skuA }], "FREEZE"));
      await store(tx, connectionId, product("p-wh", [{ id: "s-fbt", sellerSku: skuA, inventory: [{ warehouse_id: "wh-fbt", quantity: 9 }] }, { id: "s-qty", sellerSku: skuB, inventory: [{ warehouse_id: "wh-own", quantity: "3" }] }]));
      await storeTikTokListingProduct(tx, { connectionId, product: product("p-two", [{ id: "s-two", sellerSku: skuA, inventory: [{ warehouse_id: "a", quantity: 1 }, { warehouse_id: "b", quantity: 1 }] }]), ownWarehouses: new Set(["a", "b"]), readAt: NOW });
      await store(tx, connectionId, product("p-big", [{ id: "s-big", sellerSku: skuB }], "ACTIVATE", 101));
      expect(await listing(tx, "s-frozen")).toMatchObject({ holdReason: "status_not_updatable", productStatus: "FREEZE", tiktokQuantity: 2 });
      expect(await listing(tx, "s-fbt")).toMatchObject({ holdReason: "warehouse_unclear", warehouseId: null, tiktokQuantity: null });
      expect(await listing(tx, "s-qty")).toMatchObject({ holdReason: "quantity_unreadable", warehouseId: "wh-own", tiktokQuantity: null });
      expect(await listing(tx, "s-two")).toMatchObject({ holdReason: "warehouse_unclear" });
      expect(await listing(tx, "s-big")).toMatchObject({ holdReason: "product_too_many_skus" });
    });
  });

  test("a complete pass marks SKUs it did not see as not_listed, and holds a variant on several listings (R7, R9)", async () => {
    await withRollback(async (tx) => {
      const { connectionId } = await connect(tx);
      const { skuA, skuB } = await catalog(tx);
      await store(tx, connectionId, product("p1", [{ id: "s-a", sellerSku: skuA }, { id: "s-b", sellerSku: skuB }]));
      await finishTikTokListingPass(tx, { connectionId, passStart: NOW });
      expect(await listing(tx, "s-b")).toMatchObject({ holdReason: null });

      const pass2 = new Date(NOW.getTime() + 15 * MIN);
      await store(tx, connectionId, product("p1", [{ id: "s-a", sellerSku: skuA }]), pass2);
      await store(tx, connectionId, product("p2", [{ id: "s-a2", sellerSku: skuA }]), pass2);
      // Before the pass is finished nothing is marked.
      expect(await listing(tx, "s-b")).toMatchObject({ holdReason: null });
      expect(await finishTikTokListingPass(tx, { connectionId, passStart: pass2 })).toEqual({ notListed: 1, severalListings: 2 });
      expect(await listing(tx, "s-b")).toMatchObject({ holdReason: "not_listed" });
      expect(await listing(tx, "s-a")).toMatchObject({ holdReason: "variant_on_several_listings" });
      expect(await listing(tx, "s-a2")).toMatchObject({ holdReason: "variant_on_several_listings" });

      // The extra listing disappears: the next pass clears the several-listings hold.
      const pass3 = new Date(NOW.getTime() + 30 * MIN);
      await store(tx, connectionId, product("p1", [{ id: "s-a", sellerSku: skuA }]), pass3);
      await finishTikTokListingPass(tx, { connectionId, passStart: pass3 });
      expect(await listing(tx, "s-a")).toMatchObject({ holdReason: null });
      expect(await listing(tx, "s-a2")).toMatchObject({ holdReason: "not_listed" });
    });
  });
});

describe("R7 and overlapping reads (code review, 28 Nov 2026)", () => {
  test("a variant on two listings is held as soon as the second one is stored, before the pass finishes", async () => {
    await withRollback(async (tx) => {
      const { connectionId } = await connect(tx);
      const { skuA } = await catalog(tx);
      await store(tx, connectionId, product("p1", [{ id: "s-a", sellerSku: skuA }]));
      expect(await listing(tx, "s-a")).toMatchObject({ holdReason: null });
      await store(tx, connectionId, product("p2", [{ id: "s-a2", sellerSku: skuA }]));
      expect(await listing(tx, "s-a")).toMatchObject({ holdReason: "variant_on_several_listings" });
      expect(await listing(tx, "s-a2")).toMatchObject({ holdReason: "variant_on_several_listings" });
    });
  });

  test("a pass that stops early (never finished) does not reopen a several-listings hold on re-read", async () => {
    await withRollback(async (tx) => {
      const { connectionId } = await connect(tx);
      const { skuA } = await catalog(tx);
      await store(tx, connectionId, product("p1", [{ id: "s-a", sellerSku: skuA }]));
      await store(tx, connectionId, product("p2", [{ id: "s-a2", sellerSku: skuA }]));
      await finishTikTokListingPass(tx, { connectionId, passStart: NOW });
      // Pass 2 re-reads p1 only and stops (budget): no finish.
      await store(tx, connectionId, product("p1", [{ id: "s-a", sellerSku: skuA }]), new Date(NOW.getTime() + 15 * MIN));
      expect(await listing(tx, "s-a")).toMatchObject({ holdReason: "variant_on_several_listings" });
    });
  });

  test("an older pass arriving late never moves read_at backwards (so a newer finish cannot mark a live SKU not_listed)", async () => {
    await withRollback(async (tx) => {
      const { connectionId } = await connect(tx);
      const { skuA } = await catalog(tx);
      const newer = new Date(NOW.getTime() + 15 * MIN);
      await store(tx, connectionId, product("p1", [{ id: "s-a", sellerSku: skuA, inventory: [{ warehouse_id: "wh-own", quantity: 5 }] }]), newer);
      await store(tx, connectionId, product("p1", [{ id: "s-a", sellerSku: skuA, inventory: [{ warehouse_id: "wh-own", quantity: 1 }] }]), NOW);
      expect(await listing(tx, "s-a")).toMatchObject({ readAt: newer, tiktokQuantity: 5 });
      await finishTikTokListingPass(tx, { connectionId, passStart: newer });
      expect(await listing(tx, "s-a")).toMatchObject({ holdReason: null });
    });
  });
});

describe("the stock switch (R1)", () => {
  test("refused while 'Mulai terapkan pesanan' is off; stored and audited once it is on; off again", async () => {
    await withRollback(async (tx) => {
      const { staffId } = await connect(tx);
      expect(await setTikTokStockSync(tx, { enabled: true, staffUserId: staffId })).toEqual({ ok: false, reason: "orders_apply_off" });
      expect(await tiktokStockSyncEnabled(tx)).toBe(false);
      await setTikTokOrdersApply(tx, { enabled: true, staffUserId: staffId });
      expect(await setTikTokStockSync(tx, { enabled: true, staffUserId: staffId, now: NOW })).toEqual({ ok: true, changed: true });
      expect(await setTikTokStockSync(tx, { enabled: true, staffUserId: staffId })).toEqual({ ok: true, changed: false });
      expect(await tiktokStockSyncEnabled(tx)).toBe(true);
      const [row] = await tx.select().from(tiktokShopConnections);
      expect(row).toMatchObject({ stockSyncEnabled: true, stockSyncChangedByStaffUserId: staffId, stockSyncChangedAt: NOW });
      expect(await setTikTokStockSync(tx, { enabled: false, staffUserId: staffId })).toEqual({ ok: true, changed: true });
      const actions = (await tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, row!.id))).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(["tiktok_stock_sync_enable", "tiktok_stock_sync_disable"]));
    });
  });

  test("turning orders off turns stock off in the same write, audited as such", async () => {
    await withRollback(async (tx) => {
      const { connectionId, staffId } = await connect(tx);
      await setTikTokOrdersApply(tx, { enabled: true, staffUserId: staffId });
      await setTikTokStockSync(tx, { enabled: true, staffUserId: staffId });
      await setTikTokOrdersApply(tx, { enabled: false, staffUserId: staffId });
      const [row] = await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.id, connectionId));
      expect(row).toMatchObject({ ordersApplyEnabled: false, stockSyncEnabled: false });
      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, connectionId), eq(auditLog.action, "tiktok_stock_sync_disable")));
      expect(audit?.after).toEqual({ stockSyncEnabled: false, reason: "orders_apply_disabled" });
      // And it cannot be turned back on until orders are on again.
      expect(await setTikTokStockSync(tx, { enabled: true, staffUserId: staffId })).toEqual({ ok: false, reason: "orders_apply_off" });
    });
  });

  test("a direct write that skips the code still cannot break R1 (the database CHECK)", async () => {
    await withRollback(async (tx) => {
      const { connectionId } = await connect(tx);
      // A savepoint (nested transaction), so the refused statement does not abort the test's transaction.
      const error = await tx
        .transaction((sp) => sp.execute(sql`update tiktok_shop_connections set stock_sync_enabled = true where id = ${connectionId}::uuid`))
        .then(() => null)
        .catch((caught: unknown) => caught);
      expect(String((error as { cause?: unknown })?.cause ?? error)).toMatch(/stock_sync_needs_orders/);
      expect(await tiktokStockSyncEnabled(tx)).toBe(false);
    });
  });

  test("no connection → not_connected", async () => {
    await withRollback(async (tx) => {
      await tx.execute(sql`update tiktok_shop_connections set status = 'disconnected', access_token_ct = null, refresh_token_ct = null where status = 'active'`);
      const staff = await insertStaffUser(tx);
      expect(await setTikTokStockSync(tx, { enabled: true, staffUserId: staff.id })).toEqual({ ok: false, reason: "not_connected" });
    });
  });
});

describe("getTikTokStockSyncPreview (decision 1, R2)", () => {
  async function hold(tx: TestDatabase, sku: string, qty: number, expiresInMin: number) {
    const order = await insertOrder(tx, { channelId: "web", status: "awaiting_payment" });
    const [item] = await tx.insert(orderItems).values({ orderId: order.id, sku, qty, unitPrice: 259_000, unitCost: 0 }).returning();
    await tx.insert(stockReservations).values({ orderId: order.id, orderItemId: item!.id, sku, qty, expiresAt: sql`now() + make_interval(mins => ${expiresInMin}::int)` });
  }

  async function heldTikTokOrder(tx: TestDatabase, id: string, lines: unknown[], extra: Partial<typeof tiktokOrders.$inferInsert> = {}) {
    const [snapshot] = await tx
      .insert(tiktokOrderSnapshots)
      .values({ tiktokOrderId: id, updateTime: NOW, contentSha256: "a".repeat(64), payload: { id, line_items: lines }, source: "poll" })
      .returning({ id: tiktokOrderSnapshots.id });
    await tx.insert(tiktokOrders).values({ tiktokOrderId: id, status: "AWAITING_SHIPMENT", latestUpdateTime: NOW, latestSnapshotId: snapshot!.id, paidTime: NOW, applyState: "held", heldReason: "short_stock", ...extra });
  }

  test("physical − active unexpired checkout holds − held TikTok pieces; expired holds and applied/cancelled orders do not count", async () => {
    await withRollback(async (tx) => {
      const { connectionId } = await connect(tx);
      const { skuA, skuB } = await catalog(tx);
      await store(tx, connectionId, product("p1", [{ id: "s-a", sellerSku: skuA }, { id: "s-b", sellerSku: skuB, inventory: [{ warehouse_id: "wh-own", quantity: 3 }] }, { id: "s-x", sellerSku: "TIDAK-ADA" }]));
      await hold(tx, skuA, 1, 30);
      await hold(tx, skuA, 2, -5); // expired, not yet released by the sweep
      await heldTikTokOrder(tx, "580000000000000001", [{ sku_id: "s-a" }, { sku_id: "s-a", quantity: 1 }]);
      await heldTikTokOrder(tx, "580000000000000002", [{ sku_id: "s-a" }], { status: "CANCELLED" });
      await heldTikTokOrder(tx, "580000000000000003", [{ sku_id: "s-unknown" }], { heldReason: "unknown_sku" });

      const preview = await getTikTokStockSyncPreview(tx, { connectionId });
      const byId = new Map(preview.rows.map((row) => [row.tiktokSkuId, row]));
      // A: 6 physical − 1 hold − 2 held TikTok = 3; TikTok shows 2 → change.
      expect(byId.get("s-a")).toMatchObject({ state: "change", tiktokQuantity: 2, target: 3, breakdown: { physical: 6, checkoutHolds: 1, heldTikTokOrders: 2 }, variant: { sku: skuA } });
      // B: 3 physical, TikTok shows 3 → same.
      expect(byId.get("s-b")).toMatchObject({ state: "same", tiktokQuantity: 3, target: 3 });
      expect(byId.get("s-x")).toMatchObject({ state: "unmapped", target: null, holdReason: "unmapped" });
      expect(preview.counts).toEqual({ change: 1, same: 1, held: 0, unmapped: 1 });
      expect(preview.unattributedHeldOrders).toBe(1);
    });
  });

  test("a listing hold keeps the row held; an unreadable held TikTok quantity holds the variant", async () => {
    await withRollback(async (tx) => {
      const { connectionId } = await connect(tx);
      const { skuA, skuB } = await catalog(tx);
      await store(tx, connectionId, product("p1", [{ id: "s-a", sellerSku: skuA }], "FREEZE"));
      await store(tx, connectionId, product("p2", [{ id: "s-b", sellerSku: skuB }]));
      await heldTikTokOrder(tx, "580000000000000011", [{ sku_id: "s-b", quantity: "2" }]);
      const preview = await getTikTokStockSyncPreview(tx, { connectionId });
      const byId = new Map(preview.rows.map((row) => [row.tiktokSkuId, row]));
      expect(byId.get("s-a")).toMatchObject({ state: "held", holdReason: "status_not_updatable", target: null });
      expect(byId.get("s-b")).toMatchObject({ state: "held", holdReason: "tiktok_order_unclear", target: null });
    });
  });

  test("a held TikTok order whose lines cannot be read holds every mapped row (its variants are unknown)", async () => {
    await withRollback(async (tx) => {
      const { connectionId } = await connect(tx);
      const { skuA, skuB } = await catalog(tx);
      await store(tx, connectionId, product("p1", [{ id: "s-a", sellerSku: skuA }, { id: "s-b", sellerSku: skuB }]));
      await heldTikTokOrder(tx, "580000000000000021", []);
      const preview = await getTikTokStockSyncPreview(tx, { connectionId });
      expect(preview.unreadableHeldOrders).toBe(1);
      expect(preview.rows.map((row) => [row.tiktokSkuId, row.state, row.holdReason]).sort()).toEqual([
        ["s-a", "held", "tiktok_order_unclear"],
        ["s-b", "held", "tiktok_order_unclear"],
      ]);
    });
  });

  test("more listings than the limit: the preview says it is truncated and gives the total", async () => {
    await withRollback(async (tx) => {
      const { connectionId } = await connect(tx);
      const { skuA, skuB } = await catalog(tx);
      await store(tx, connectionId, product("p1", [{ id: "s-a", sellerSku: skuA }, { id: "s-b", sellerSku: skuB }]));
      expect(await getTikTokStockSyncPreview(tx, { connectionId, limit: 1 })).toMatchObject({ total: 2, truncated: true });
      expect(await getTikTokStockSyncPreview(tx, { connectionId })).toMatchObject({ total: 2, truncated: false });
    });
  });

  test("no connection → an empty preview", async () => {
    await withRollback(async (tx) => {
      expect(await getTikTokStockSyncPreview(tx, { connectionId: null })).toMatchObject({ rows: [], counts: { change: 0, same: 0, held: 0, unmapped: 0 } });
    });
  });
});

// ---- The read pass inside runTikTokSync -------------------------------------------------------

interface FakeShop {
  fetch: FetchLike;
  products: unknown[];
  warehouses: unknown[];
  paths: { method: string; path: string }[];
  clock: { ms: number };
}

function fakeShop(clock: { ms: number }): FakeShop {
  const fake: FakeShop = {
    products: [],
    warehouses: [{ id: "wh-own", type: "SALES_WAREHOUSE", sub_type: "DOMESTIC_WAREHOUSE" }],
    paths: [],
    clock,
    fetch: async (input, init) => {
      const url = new URL(input);
      fake.paths.push({ method: String(init.method), path: url.pathname });
      const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: "Success", request_id: "fake", data }), { status: 200 });
      if (url.pathname === "/order/202309/orders/search") return ok({ orders: [], next_page_token: "" });
      if (url.pathname === "/return_refund/202309/returns/search") return ok({ return_orders: [], next_page_token: "" });
      if (url.pathname === "/return_refund/202309/cancellations/search") return ok({ cancellations: [], next_page_token: "" });
      if (url.pathname === "/logistics/202309/warehouses") return ok({ warehouses: fake.warehouses });
      if (url.pathname === "/product/202309/products/search") {
        // One product per page, so the pass pages.
        const offset = Number(url.searchParams.get("page_token") ?? "0");
        const next = offset + 1 < fake.products.length ? String(offset + 1) : "";
        return ok({ products: fake.products.slice(offset, offset + 1), next_page_token: next, total_count: fake.products.length });
      }
      return new Response(JSON.stringify({ code: 40001, message: "nope", request_id: "x" }), { status: 404 });
    },
  };
  return fake;
}

const refusingAuth: TikTokAuthClient = {
  getAccessToken: async () => {
    throw new Error("test: no token exchange expected");
  },
  refreshAccessToken: async () => {
    throw new Error("test: no refresh expected");
  },
};

function deps(fake: FakeShop) {
  const api = createTikTokClient({ appKey: new Secret("dummyappkey"), appSecret: new Secret("dummyappsecret0123456789"), baseUrl: "https://tiktok.test", fetch: fake.fetch, now: () => fake.clock.ms, sleep: async () => {} });
  return { api, auth: refusingAuth, keyring: KEYRING, now: () => new Date(fake.clock.ms) };
}

const rawProduct = (id: string, skus: { id: string; seller_sku: string; quantity?: unknown }[]) => ({
  id,
  status: "ACTIVATE",
  title: `Gamis ${id}`,
  skus: skus.map((sku) => ({ id: sku.id, seller_sku: sku.seller_sku, inventory: [{ warehouse_id: "wh-own", quantity: sku.quantity ?? 1 }] })),
});

describe("runTikTokSync: the listing read pass", () => {
  test("reads every page when due, stores listings, marks the cursor ok, never calls anything but reads; not due 15 minutes later", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const { skuA, skuB } = await catalog(tx);
      const clock = { ms: NOW.getTime() };
      const fake = fakeShop(clock);
      fake.products = [rawProduct("p1", [{ id: "s-a", seller_sku: skuA }]), rawProduct("p2", [{ id: "s-b", seller_sku: skuB }])];
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.error).toBeNull();
      expect(summary.listings).toMatchObject({ skipped: null, complete: true, pages: 2, products: 2, skus: 2, autoMapped: 2, invalid: 0, ownWarehouses: 1 });
      expect((await tx.select().from(tiktokListingSkus)).map((row) => row.tiktokSkuId).sort()).toEqual(["s-a", "s-b"]);
      const [cursor] = await tx.select().from(tiktokSyncCursors).where(eq(tiktokSyncCursors.resource, "products"));
      expect(cursor?.lastOkAt).not.toBeNull();
      // Read only: no path outside the read endpoints, and no inventory update.
      expect(fake.paths.every((call) => !call.path.includes("inventory"))).toBe(true);
      expect(new Set(fake.paths.map((call) => call.path))).toEqual(new Set(["/order/202309/orders/search", "/return_refund/202309/returns/search", "/return_refund/202309/cancellations/search", "/logistics/202309/warehouses", "/product/202309/products/search"]));

      clock.ms += TIKTOK_LISTINGS_EVERY_MS - MIN;
      expect((await runTikTokSync(tx, deps(fake))).listings.skipped).toBe("not_due");
      clock.ms += 2 * MIN;
      expect((await runTikTokSync(tx, deps(fake))).listings.skipped).toBeNull();
    });
  });

  test("an unusable product entry holds the pass: incomplete, nothing marked not_listed, cursor not ok", async () => {
    await withRollback(async (tx) => {
      const { connectionId } = await connect(tx);
      const { skuA, skuB } = await catalog(tx);
      await store(tx, connectionId, product("p-old", [{ id: "s-old", sellerSku: skuB }]), new Date(NOW.getTime() - DAY));
      const clock = { ms: NOW.getTime() };
      const fake = fakeShop(clock);
      fake.products = [rawProduct("p1", [{ id: "s-a", seller_sku: skuA }]), { status: "ACTIVATE" }];
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.error).toEqual({ kind: "incomplete", code: "listings_invalid" });
      expect(summary.listings).toMatchObject({ complete: false, invalid: 1, stoppedBy: "listings_invalid" });
      expect(await listing(tx, "s-old")).toMatchObject({ holdReason: null });
      const [cursor] = await tx.select().from(tiktokSyncCursors).where(eq(tiktokSyncCursors.resource, "products"));
      expect(cursor).toMatchObject({ lastOkAt: null, lastErrorCode: "listings_invalid" });
    });
  });

  test("a refused Search Products holds only the listing cursor", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const clock = { ms: NOW.getTime() };
      const fake = fakeShop(clock);
      const inner = fake.fetch;
      fake.fetch = async (input, init) => (new URL(input).pathname === "/product/202309/products/search" ? new Response(JSON.stringify({ code: 12019999, message: "x", request_id: "r" }), { status: 200 }) : inner(input, init));
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.error).toEqual({ kind: "incomplete", code: "listings_invalid" });
      expect(summary.listings.stoppedBy).toMatch(/12019999/);
      const [orders] = await tx.select().from(tiktokSyncCursors).where(eq(tiktokSyncCursors.resource, "orders"));
      expect(orders?.lastErrorCode).toBeNull();
    });
  });

  test("the last page came early (TikTok's total_count not reached): refused, nothing marked not_listed", async () => {
    await withRollback(async (tx) => {
      const { connectionId } = await connect(tx);
      const { skuA, skuB } = await catalog(tx);
      await store(tx, connectionId, product("p2", [{ id: "s-b", sellerSku: skuB }]), new Date(NOW.getTime() - DAY));
      const clock = { ms: NOW.getTime() };
      const fake = fakeShop(clock);
      fake.products = [rawProduct("p1", [{ id: "s-a", seller_sku: skuA }])];
      const inner = fake.fetch;
      // TikTok says 2 products but hands back no next_page_token after the first.
      fake.fetch = async (input, init) =>
        new URL(input).pathname === "/product/202309/products/search"
          ? new Response(JSON.stringify({ code: 0, message: "ok", request_id: "r", data: { products: fake.products, total_count: 2 } }), { status: 200 })
          : inner(input, init);
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.error).toEqual({ kind: "incomplete", code: "listings_invalid" });
      expect(summary.listings.stoppedBy).toBe("invalid_response:count_mismatch");
      expect(await listing(tx, "s-b")).toMatchObject({ holdReason: null });
    });
  });

  test("running out of the step's budget share: incomplete but quiet, recorded on the cursor, the run goes on", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const { skuA } = await catalog(tx);
      const clock = { ms: NOW.getTime() };
      const fake = fakeShop(clock);
      fake.products = [rawProduct("p1", [{ id: "s-a", seller_sku: skuA }]), rawProduct("p2", [{ id: "s-b", seller_sku: skuA }]), rawProduct("p3", [{ id: "s-c", seller_sku: skuA }])];
      const inner = fake.fetch;
      // Each product page costs 30 s: the listing step's quarter (37.5 s of 150 s) runs out after two.
      fake.fetch = async (input, init) => {
        if (new URL(input).pathname === "/product/202309/products/search") clock.ms += 30_000;
        return inner(input, init);
      };
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.error).toBeNull();
      expect(summary.listings).toMatchObject({ complete: false, stoppedBy: "budget_exhausted", pages: 2 });
      const [cursor] = await tx.select().from(tiktokSyncCursors).where(eq(tiktokSyncCursors.resource, "products"));
      expect(cursor).toMatchObject({ lastOkAt: null, lastErrorCode: "budget_exhausted" });
    });
  });

  test("without seller.product.basic or seller.logistics the pass is skipped (no_scope), no listing call", async () => {
    await withRollback(async (tx) => {
      await connect(tx, ["seller.order.info", "seller.product.basic"]);
      const fake = fakeShop({ ms: NOW.getTime() });
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.listings.skipped).toBe("no_scope");
      expect(fake.paths.some((call) => call.path.startsWith("/product") || call.path.startsWith("/logistics"))).toBe(false);
    });
  });
});
