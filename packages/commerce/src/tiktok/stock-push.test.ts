import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { auditLog, orderItems, productVariants, stockMovements, tiktokListingSkus, tiktokOrderSnapshots, tiktokOrders, tiktokSkuMappings, tiktokStockOutbox, tiktokStockPushRetries, tiktokSyncCursors, STOCK_MOVEMENT_TYPES } from "@ammari/db/schema";
import { insertOrder, insertProductVariant, insertStaffUser, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { Secret, createTikTokClient, type FetchLike, type TikTokAuthClient, type TikTokListingProductRecord, type TokenKeyring } from "@ammari/tiktok-shop";
import { adjustStock, saveStockCount } from "../stock/ledger";
import { consumeReservationsForOrder, releaseReservationsForOrder, reserveStockForOrder } from "../stock/reservations";
import { setTikTokOrdersApply } from "./apply";
import { saveTikTokConnection } from "./connection";
import { mapTikTokSku, unmapTikTokSku } from "./sku-mappings";
import { getTikTokStockPushHealth, prepareTikTokStockOutbox, emptyTikTokStockPushCounts, queueTikTokListingDrift, retryRefusedTikTokStockPushes, tiktokStockPushGate } from "./stock-push";
import { setTikTokStockSync, storeTikTokListingProduct } from "./stock-sync";
import { pushTikTokStockNow, runTikTokSync } from "./sync";

// docs/plans/tiktok-stock-sync.md S2 against a real database (every test rolls back): the dirty-variant
// outbox written by each writer type in the writer's own transaction (database triggers, so a new writer
// cannot forget it), the gate (switch, scope, R11), the push through a fake TikTok (one call per product,
// INCREMENTAL, own warehouse only, never an unmapped SKU, the target recomputed at send time), per-SKU
// errors, backoff, hold expiry, the full reconciliation, health and "Kirim ulang". No real TikTok call:
// the fake answers everything, and the package's test setup refuses any non-local fetch.

const DAY = 86_400_000;
const MIN = 60_000;
const KEYRING: TokenKeyring = { currentVersion: 1, keys: new Map([[1, new Secret(new Uint8Array(32).fill(7))]]) };
const OWN = new Set(["wh-own"]);
const ALL_SCOPES = ["seller.order.info", "seller.product.basic", "seller.logistics", "seller.product.write"];

async function dbNow(db: TestDatabase): Promise<Date> {
  const [row] = await db.execute<{ now: string | Date }>(sql`select now() as now`);
  return new Date(row!.now);
}

async function connect(db: TestDatabase, scopes = ALL_SCOPES): Promise<{ connectionId: string; staffId: string }> {
  const staff = await insertStaffUser(db);
  const now = Date.now();
  const result = await saveTikTokConnection(db, {
    tokens: {
      accessToken: new Secret("ROW_access_push"),
      accessTokenExpiresAt: new Date(now + 7 * DAY),
      refreshToken: new Secret("ROW_refresh_push"),
      refreshTokenExpiresAt: new Date(now + 60 * DAY),
      grantedScopes: scopes,
      sellerName: "Ammari",
      sellerBaseRegion: "ID",
    },
    shop: { shopId: "7495540735365777888", shopCipher: "ROW_cipher", shopName: "Ammari", region: "ID", sellerType: "LOCAL" },
    staffUserId: staff.id,
    keyring: KEYRING,
    now: new Date(now - DAY),
  });
  if (!result.ok) throw new Error(result.reason);
  return { connectionId: result.connectionId, staffId: staff.id };
}

/** Variant A (6 pieces, product P-A) and variant B (3 pieces, another product). */
async function catalog(db: TestDatabase) {
  const { fabric, color, variant, product } = await insertProductVariant(db);
  const second = await insertVariantForProduct(db, fabric.id, color.id, {}, "L");
  const skuA = variant.sku.toUpperCase();
  const skuB = second.variant.sku.toUpperCase();
  await db.update(productVariants).set({ sku: skuA }).where(eq(productVariants.sku, variant.sku));
  await db.update(productVariants).set({ sku: skuB }).where(eq(productVariants.sku, second.variant.sku));
  await db.insert(stockMovements).values([
    { sku: skuA, qty: 6, valueAmount: 600_000, type: "production", refType: "manual" },
    { sku: skuB, qty: 3, valueAmount: 270_000, type: "production", refType: "manual" },
  ]);
  return { skuA, skuB, productIdA: product.id };
}

function product(productId: string, skus: { id: string; sellerSku: string | null; inventory?: unknown }[], status = "ACTIVATE"): TikTokListingProductRecord {
  return {
    productId,
    status,
    title: `Gamis ${productId}`,
    skus: skus.map((sku) => ({ skuId: sku.id, sellerSku: sku.sellerSku, label: "Hitam · M", inventory: (sku.inventory ?? [{ warehouse_id: "wh-own", quantity: 2 }, { warehouse_id: "wh-fbt", quantity: 40 }]) as never })),
    skuCount: skus.length,
    invalidSkus: 0,
  };
}

async function markListingsRead(db: TestDatabase, at?: Date) {
  await db.execute(sql`
    insert into tiktok_sync_cursors (resource, last_ok_at, last_run_at) values ('products', ${(at ?? (await dbNow(db))).toISOString()}::timestamptz, now())
    on conflict (resource) do update set last_ok_at = excluded.last_ok_at, last_error_code = null
  `);
}

async function marks(db: TestDatabase, sku?: string) {
  const rows = await db.select().from(tiktokStockOutbox).orderBy(tiktokStockOutbox.id);
  return sku ? rows.filter((row) => row.variantSku === sku) : rows;
}

async function clearMarks(db: TestDatabase) {
  await db.delete(tiktokStockOutbox);
}

async function enableStockSync(db: TestDatabase, staffId: string) {
  expect(await setTikTokOrdersApply(db, { enabled: true, staffUserId: staffId })).toMatchObject({ ok: true });
  expect(await setTikTokStockSync(db, { enabled: true, staffUserId: staffId })).toEqual({ ok: true, changed: true });
}

/** A connected shop, two products on TikTok (P1: s-a → A, s-x unmapped; P2: s-b → B), listings read now,
 * orders apply and the stock switch ON. TikTok shows 2 at the own warehouse (and 40 at an FBT one). */
async function pushable(db: TestDatabase) {
  const { connectionId, staffId } = await connect(db);
  const cat = await catalog(db);
  const readAt = await dbNow(db);
  await storeTikTokListingProduct(db, { connectionId, product: product("p1", [{ id: "s-a", sellerSku: cat.skuA }, { id: "s-x", sellerSku: "TIDAK-ADA" }]), ownWarehouses: OWN, readAt });
  await storeTikTokListingProduct(db, { connectionId, product: product("p2", [{ id: "s-b", sellerSku: cat.skuB }]), ownWarehouses: OWN, readAt });
  await markListingsRead(db, readAt);
  await enableStockSync(db, staffId);
  return { connectionId, staffId, ...cat };
}

type InventoryCall = { productId: string; body: { skus: { id: string; inventory: { warehouse_id: string; quantity: number }[] }[]; sku_warehouse_stock_update_mode: string } };

interface FakeTikTok {
  fetch: FetchLike;
  calls: InventoryCall[];
  /** Per call, what to answer (default: success). */
  reply: (call: InventoryCall) => { status?: number; body: unknown } | null;
  paths: string[];
}

function fakeTikTok(): FakeTikTok {
  const fake: FakeTikTok = {
    calls: [],
    paths: [],
    reply: () => null,
    fetch: async (input, init) => {
      const url = new URL(input);
      fake.paths.push(url.pathname);
      const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: "Success", request_id: "fake", data }), { status: 200 });
      const inventory = /^\/product\/202309\/products\/([^/]+)\/inventory\/update$/.exec(url.pathname);
      if (inventory) {
        const call = { productId: decodeURIComponent(inventory[1]!), body: JSON.parse(String(init.body)) as InventoryCall["body"] };
        fake.calls.push(call);
        const custom = fake.reply(call);
        return custom ? new Response(JSON.stringify(custom.body), { status: custom.status ?? 200 }) : ok({});
      }
      if (url.pathname === "/order/202309/orders/search") return ok({ orders: [], next_page_token: "" });
      if (url.pathname === "/return_refund/202309/returns/search") return ok({ return_orders: [], next_page_token: "" });
      if (url.pathname === "/return_refund/202309/cancellations/search") return ok({ cancellations: [], next_page_token: "" });
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

function deps(fake: FakeTikTok, now: () => Date = () => new Date()) {
  const api = createTikTokClient({ appKey: new Secret("dummyappkey"), appSecret: new Secret("dummyappsecret0123456789"), baseUrl: "https://tiktok.test", fetch: fake.fetch, sleep: async () => {} });
  return { api, auth: refusingAuth, keyring: KEYRING, now };
}

async function listing(db: TestDatabase, skuId: string) {
  const [row] = await db.select().from(tiktokListingSkus).where(eq(tiktokListingSkus.tiktokSkuId, skuId));
  return row!;
}

async function hold(db: TestDatabase, sku: string, qty: number, expiresInMin: number) {
  const order = await insertOrder(db, { channelId: "web", status: "awaiting_payment" });
  const [item] = await db.insert(orderItems).values({ orderId: order.id, sku, qty, unitPrice: 259_000, unitCost: 0 }).returning();
  return { order, item: item! };
}

async function tiktokOrder(db: TestDatabase, id: string, lines: unknown, extra: Partial<typeof tiktokOrders.$inferInsert> = {}) {
  const at = new Date("2026-12-02T03:00:00.000Z");
  const [snapshot] = await db
    .insert(tiktokOrderSnapshots)
    .values({ tiktokOrderId: id, updateTime: at, contentSha256: "b".repeat(64), payload: { id, line_items: lines } as never, source: "poll" })
    .returning({ id: tiktokOrderSnapshots.id });
  await db.insert(tiktokOrders).values({ tiktokOrderId: id, status: "AWAITING_SHIPMENT", latestUpdateTime: at, latestSnapshotId: snapshot!.id, paidTime: at, applyState: "held", heldReason: "short_stock", ...extra });
  return snapshot!.id;
}

// ---- The outbox: every writer, in its own transaction ----------------------------------------------

describe("tiktok_stock_outbox: written in the writer's own transaction by every change of the target", () => {
  test("the triggers exist and are enabled on all four tables (a new writer of these tables cannot skip them)", async () => {
    await withRollback(async (tx) => {
      const rows = await tx.execute<{ tbl: string; tgname: string; tgenabled: string }>(sql`
        select tgrelid::regclass::text as tbl, tgname, tgenabled from pg_trigger
        where tgname in ('tiktok_stock_dirty', 'tiktok_stock_dirty_on_change') order by 1, 2
      `);
      expect(rows.map((row) => `${row.tbl}:${row.tgname}:${row.tgenabled}`)).toEqual([
        "stock_movements:tiktok_stock_dirty:O",
        "stock_reservations:tiktok_stock_dirty:O",
        "stock_reservations:tiktok_stock_dirty_on_change:O",
        "tiktok_orders:tiktok_stock_dirty:O",
        "tiktok_orders:tiktok_stock_dirty_on_change:O",
        "tiktok_sku_mappings:tiktok_stock_dirty:O",
        "tiktok_sku_mappings:tiktok_stock_dirty_on_change:O",
      ]);
    });
  });

  test("every stock movement type, written any way at all (a raw INSERT), marks its variant", async () => {
    await withRollback(async (tx) => {
      const { skuA } = await pushable(tx);
      await clearMarks(tx);
      for (const type of STOCK_MOVEMENT_TYPES) {
        await tx.insert(stockMovements).values({ sku: skuA, qty: type === "sale" ? -1 : 1, valueAmount: 0, type, refType: "manual", ...(type === "adjustment" ? { reason: "recount" as const } : {}) });
      }
      expect((await marks(tx, skuA)).map((row) => row.source)).toEqual(STOCK_MOVEMENT_TYPES.map(() => "stock"));
    });
  });

  test("the ledger functions (manual adjustment, opname) mark in their transaction; a rolled-back write leaves no mark", async () => {
    await withRollback(async (tx) => {
      const { skuA, staffId, productIdA } = await pushable(tx);
      await clearMarks(tx);
      await adjustStock({ sku: skuA, deltaQty: -1, reason: "damaged" }, staffId, tx);
      expect(await marks(tx, skuA)).toHaveLength(1);
      await saveStockCount(productIdA, [{ sku: skuA, physicalQty: 2 }], staffId, tx);
      expect(await marks(tx, skuA)).toHaveLength(2);
      // A savepoint that fails after the movement: the mark goes with it.
      await tx
        .transaction(async (inner) => {
          await adjustStock({ sku: skuA, deltaQty: 1, reason: "other" }, staffId, inner);
          throw new Error("roll back");
        })
        .catch(() => undefined);
      expect(await marks(tx, skuA)).toHaveLength(2);
      // A refused write (stock would go negative) writes nothing.
      await expect(adjustStock({ sku: skuA, deltaQty: -100, reason: "damaged" }, staffId, tx)).rejects.toThrow();
      expect(await marks(tx, skuA)).toHaveLength(2);
    });
  });

  test("checkout holds: create, consume, release each mark the variant (source hold)", async () => {
    await withRollback(async (tx) => {
      const { skuA, skuB } = await pushable(tx);
      await clearMarks(tx);
      const first = await hold(tx, skuA, 1, 75);
      await reserveStockForOrder(tx, first.order.id, [{ orderItemId: first.item.id, sku: skuA, qty: 1 }], 75);
      expect((await marks(tx, skuA)).map((row) => row.source)).toEqual(["hold"]);
      await consumeReservationsForOrder(tx, first.order.id);
      expect(await marks(tx, skuA)).toHaveLength(2);
      const second = await hold(tx, skuB, 1, 75);
      await reserveStockForOrder(tx, second.order.id, [{ orderItemId: second.item.id, sku: skuB, qty: 1 }], 75);
      await releaseReservationsForOrder(tx, second.order.id);
      expect(await marks(tx, skuB)).toHaveLength(2);
      // A replayed release changes no row: no new mark.
      await releaseReservationsForOrder(tx, second.order.id);
      expect(await marks(tx, skuB)).toHaveLength(2);
    });
  });

  test("SKU mapping changes mark the old and the new variant (map, re-map, unmap)", async () => {
    await withRollback(async (tx) => {
      const { skuA, skuB, staffId } = await pushable(tx);
      await clearMarks(tx);
      expect(await mapTikTokSku(tx, { tiktokSkuId: "s-a", variantSku: skuB, staffUserId: staffId })).toMatchObject({ ok: true });
      expect((await marks(tx)).map((row) => `${row.variantSku === skuA ? "A" : "B"}:${row.source}`).sort()).toEqual(["A:mapping", "B:mapping"]);
      await clearMarks(tx);
      expect(await unmapTikTokSku(tx, { tiktokSkuId: "s-a", staffUserId: staffId })).toMatchObject({ ok: true });
      expect((await marks(tx)).map((row) => row.variantSku)).toEqual([skuB]);
    });
  });

  test("TikTok orders (R2 inputs): a held sale appearing, being applied or cancelled marks the variants its lines map to; unreadable lines mark every mapped variant", async () => {
    await withRollback(async (tx) => {
      const { skuA, skuB } = await pushable(tx);
      await clearMarks(tx);
      await tiktokOrder(tx, "580000000000000101", [{ sku_id: "s-a", quantity: 1 }, { sku_id: "s-unmapped" }]);
      expect((await marks(tx)).map((row) => `${row.variantSku === skuA ? "A" : "?"}:${row.source}`)).toEqual(["A:tiktok_order"]);
      await clearMarks(tx);
      await tx.update(tiktokOrders).set({ status: "CANCELLED" }).where(eq(tiktokOrders.tiktokOrderId, "580000000000000101"));
      expect((await marks(tx)).map((row) => row.variantSku)).toEqual([skuA]);
      await clearMarks(tx);
      // A change that cannot move the target (the buyer message) marks nothing.
      await tx.update(tiktokOrders).set({ buyerMessage: "tolong cepat" }).where(eq(tiktokOrders.tiktokOrderId, "580000000000000101"));
      expect(await marks(tx)).toHaveLength(0);
      await tiktokOrder(tx, "580000000000000102", "not a list");
      expect(new Set((await marks(tx)).map((row) => row.variantSku))).toEqual(new Set([skuA, skuB]));
    });
  });

  test("nothing is marked while no connection has the stock switch on", async () => {
    await withRollback(async (tx) => {
      const { skuA, staffId } = await pushable(tx);
      expect(await setTikTokStockSync(tx, { enabled: false, staffUserId: staffId })).toMatchObject({ ok: true, changed: true });
      await clearMarks(tx);
      await adjustStock({ sku: skuA, deltaQty: 1, reason: "other" }, staffId, tx);
      expect(await marks(tx)).toHaveLength(0);
    });
  });

  test("turning the switch on queues every mapped listing's variant (the first full push)", async () => {
    await withRollback(async (tx) => {
      const { connectionId, staffId } = await connect(tx);
      const { skuA, skuB } = await catalog(tx);
      await storeTikTokListingProduct(tx, { connectionId, product: product("p1", [{ id: "s-a", sellerSku: skuA }, { id: "s-x", sellerSku: "TIDAK-ADA" }, { id: "s-b", sellerSku: skuB }]), ownWarehouses: OWN, readAt: await dbNow(tx) });
      await clearMarks(tx);
      await enableStockSync(tx, staffId);
      const rows = await marks(tx);
      expect(rows.every((row) => row.source === "enable")).toBe(true);
      expect(new Set(rows.map((row) => row.variantSku))).toEqual(new Set([skuA, skuB]));
    });
  });
});

// ---- The gate ---------------------------------------------------------------------------------------

describe("the push gate: switch, R1, scope, R11", () => {
  test("switch OFF → nothing is pushed and the marks wait", async () => {
    await withRollback(async (tx) => {
      const { staffId, skuA } = await pushable(tx);
      // Orders apply off turns the stock switch off with it (R1, the 0064 trigger).
      await setTikTokOrdersApply(tx, { enabled: false, staffUserId: staffId });
      await clearMarks(tx);
      await tx.insert(tiktokStockOutbox).values({ variantSku: skuA, source: "stock" });
      const fake = fakeTikTok();
      expect(await pushTikTokStockNow(tx, deps(fake))).toBeNull();
      expect(await tiktokStockPushGate(tx)).toMatchObject({ ok: false, reason: "switch_off" });
      expect(fake.calls).toHaveLength(0);
      expect(await marks(tx, skuA)).toHaveLength(1);
    });
  });

  test("no seller.product.write → no_scope, no call", async () => {
    await withRollback(async (tx) => {
      await pushable(tx);
      await tx.execute(sql`update tiktok_shop_connections set granted_scopes = array['seller.order.info','seller.product.basic','seller.logistics'] where status = 'active'`);
      const fake = fakeTikTok();
      expect(await pushTikTokStockNow(tx, deps(fake))).toMatchObject({ skipped: "no_scope", calls: 0 });
      expect(fake.calls).toHaveLength(0);
    });
  });

  test("R11: no complete read in the last 2 h, or a read failing since → nothing is pushed", async () => {
    await withRollback(async (tx) => {
      await pushable(tx);
      const fake = fakeTikTok();
      await tx.execute(sql`update tiktok_sync_cursors set last_ok_at = now() - interval '121 minutes' where resource = 'products'`);
      expect(await pushTikTokStockNow(tx, deps(fake))).toMatchObject({ skipped: "listings_stale" });
      await tx.execute(sql`update tiktok_sync_cursors set last_ok_at = now(), last_error_code = 'listings_invalid' where resource = 'products'`);
      expect(await pushTikTokStockNow(tx, deps(fake))).toMatchObject({ skipped: "listings_failing" });
      expect(fake.calls).toHaveLength(0);
    });
  });
});

// ---- The push -----------------------------------------------------------------------------------------

describe("pushTikTokStockNow / the drain", () => {
  test("one call per product, INCREMENTAL, only the own warehouse (never the FBT one), never an unmapped SKU; then the marks are gone", async () => {
    await withRollback(async (tx) => {
      const { skuA, skuB } = await pushable(tx);
      const fake = fakeTikTok();
      const counts = await pushTikTokStockNow(tx, deps(fake));
      expect(counts).toMatchObject({ skipped: null, calls: 2, pushed: 2, failed: 0, refused: 0 });
      expect(fake.calls.map((call) => call.productId).sort()).toEqual(["p1", "p2"]);
      for (const call of fake.calls) {
        expect(call.body.sku_warehouse_stock_update_mode).toBe("INCREMENTAL");
        for (const sku of call.body.skus) expect(sku.inventory).toEqual([{ warehouse_id: "wh-own", quantity: expect.any(Number) }]);
      }
      const sent = fake.calls.flatMap((call) => call.body.skus);
      expect(sent.map((sku) => sku.id).sort()).toEqual(["s-a", "s-b"]);
      expect(sent.find((sku) => sku.id === "s-a")!.inventory[0]!.quantity).toBe(6);
      expect(sent.find((sku) => sku.id === "s-b")!.inventory[0]!.quantity).toBe(3);
      expect(await listing(tx, "s-a")).toMatchObject({ lastPushedQuantity: 6, lastPushErrorCode: null });
      expect(await listing(tx, "s-x")).toMatchObject({ lastPushedQuantity: null });
      expect(await marks(tx, skuA)).toHaveLength(0);
      expect(await marks(tx, skuB)).toHaveLength(0);
      // Nothing changed since: nothing due, no call.
      expect(await pushTikTokStockNow(tx, deps(fake))).toBeNull();
      expect(fake.calls).toHaveLength(2);
    });
  });

  test("the target is recomputed at send time, never a queued value: a later sale and an active hold are in it", async () => {
    await withRollback(async (tx) => {
      const { skuA, staffId } = await pushable(tx);
      await adjustStock({ sku: skuA, deltaQty: -2, reason: "damaged" }, staffId, tx);
      const h = await hold(tx, skuA, 1, 75);
      await reserveStockForOrder(tx, h.order.id, [{ orderItemId: h.item.id, sku: skuA, qty: 1 }], 75);
      const fake = fakeTikTok();
      await pushTikTokStockNow(tx, deps(fake));
      const sent = fake.calls.flatMap((call) => call.body.skus).find((sku) => sku.id === "s-a");
      expect(sent!.inventory[0]!.quantity).toBe(3); // 6 − 2 − 1 hold
    });
  });

  test("target equal to TikTok's quantity → no call (first push compares with the read quantity)", async () => {
    await withRollback(async (tx) => {
      const { skuA, skuB, connectionId } = await pushable(tx);
      await tx.update(tiktokListingSkus).set({ tiktokQuantity: 6 }).where(eq(tiktokListingSkus.tiktokSkuId, "s-a"));
      await tx.update(tiktokListingSkus).set({ tiktokQuantity: 3 }).where(eq(tiktokListingSkus.tiktokSkuId, "s-b"));
      const fake = fakeTikTok();
      expect(await pushTikTokStockNow(tx, deps(fake))).toMatchObject({ calls: 0, unchanged: 2 });
      expect(fake.calls).toHaveLength(0);
      expect(await marks(tx, skuA)).toHaveLength(0);
      expect(await marks(tx, skuB)).toHaveLength(0);
      expect(connectionId).toBeTruthy();
    });
  });

  test("a hold expiry raises the target and queues a push (the cron's hold_expiry scan)", async () => {
    await withRollback(async (tx) => {
      const { skuA, staffId } = await pushable(tx);
      // TikTok already shows 5 (= 6 − the hold); the hold then expires without any write.
      await tx.update(tiktokListingSkus).set({ tiktokQuantity: 5 }).where(eq(tiktokListingSkus.tiktokSkuId, "s-a"));
      const h = await hold(tx, skuA, 1, 75);
      await reserveStockForOrder(tx, h.order.id, [{ orderItemId: h.item.id, sku: skuA, qty: 1 }], 75);
      const fake = fakeTikTok();
      await pushTikTokStockNow(tx, deps(fake));
      expect(fake.calls.flatMap((call) => call.body.skus).find((sku) => sku.id === "s-a")).toBeUndefined();
      expect(await marks(tx, skuA)).toHaveLength(0);
      // Expired now (the transaction's clock is fixed, so the hold is moved into the past).
      await tx.execute(sql`alter table stock_reservations disable trigger tiktok_stock_dirty_on_change`);
      await tx.execute(sql`update stock_reservations set expires_at = now() - interval '1 minute' where order_id = ${h.order.id}::uuid`);
      await tx.execute(sql`alter table stock_reservations enable trigger tiktok_stock_dirty_on_change`);
      expect(await marks(tx, skuA)).toHaveLength(0);
      const counts = emptyTikTokStockPushCounts();
      await prepareTikTokStockOutbox(tx, counts);
      expect(counts.expiredHolds).toBe(1);
      expect((await marks(tx, skuA)).map((row) => row.source)).toContain("hold_expiry");
      await pushTikTokStockNow(tx, deps(fake));
      expect(fake.calls.at(-1)!.body.skus).toEqual([{ id: "s-a", inventory: [{ warehouse_id: "wh-own", quantity: 6 }] }]);
      // The same expiry is never queued twice (the watermark moved).
      const again = emptyTikTokStockPushCounts();
      await prepareTikTokStockOutbox(tx, again);
      expect(again.expiredHolds).toBe(0);
      expect(staffId).toBeTruthy();
    });
  });

  test("per-SKU errors under code 0: a promotion lock is held (refused, no retry); Kirim ulang clears it and queues the variant", async () => {
    await withRollback(async (tx) => {
      const { skuA, staffId } = await pushable(tx);
      const fake = fakeTikTok();
      fake.reply = (call) => (call.productId === "p1" ? { body: { code: 0, message: "partial", request_id: "r", data: { errors: [{ code: 12052393, message: "promotion", detail: { sku_id: "s-a" } }] } } } : null);
      const counts = await pushTikTokStockNow(tx, deps(fake));
      expect(counts).toMatchObject({ pushed: 1, refused: 1, failed: 0 });
      expect(await listing(tx, "s-a")).toMatchObject({ lastPushedQuantity: null, lastPushErrorCode: "12052393" });
      // Never retried in a loop: the mark is gone, no retry row, and a new stock change holds it.
      expect(await marks(tx, skuA)).toHaveLength(0);
      expect(await tx.select().from(tiktokStockPushRetries)).toHaveLength(0);
      await adjustStock({ sku: skuA, deltaQty: -1, reason: "damaged" }, staffId, tx);
      expect(await pushTikTokStockNow(tx, deps(fake))).toMatchObject({ calls: 0, held: 1 });

      const health = await getTikTokStockPushHealth(tx, (await tiktokStockPushGate(tx)).connectionId);
      expect(health.failed).toEqual([expect.objectContaining({ tiktokSkuId: "s-a", code: "12052393", action: "hold" })]);

      expect(await retryRefusedTikTokStockPushes(tx, { staffUserId: staffId })).toEqual({ ok: true, cleared: 1 });
      expect((await marks(tx, skuA)).map((row) => row.source)).toContain("retry");
      fake.reply = () => null;
      expect(await pushTikTokStockNow(tx, deps(fake))).toMatchObject({ pushed: 1 });
      expect(await listing(tx, "s-a")).toMatchObject({ lastPushedQuantity: 5, lastPushErrorCode: null });
      const audits = await tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.action, "tiktok_stock_push_retry"));
      expect(audits).toHaveLength(1);
    });
  });

  test("a status error holds the SKU until a newer read; then it is tried again", async () => {
    await withRollback(async (tx) => {
      const { skuA, connectionId } = await pushable(tx);
      const fake = fakeTikTok();
      fake.reply = (call) => (call.productId === "p1" ? { body: { code: 12052901, message: "status", request_id: "r" } } : null);
      expect(await pushTikTokStockNow(tx, deps(fake))).toMatchObject({ refused: 1 });
      expect((await getTikTokStockPushHealth(tx, connectionId)).failed[0]).toMatchObject({ code: "12052901", action: "reread" });
      // A newer read pass saw the listing again (read_at after the refusal).
      fake.reply = () => null;
      await tx.execute(sql`update tiktok_listing_skus set last_push_error_at = now() - interval '1 minute' where tiktok_sku_id = 's-a'`);
      await tx.insert(tiktokStockOutbox).values({ variantSku: skuA, source: "listing" });
      expect(await pushTikTokStockNow(tx, deps(fake))).toMatchObject({ pushed: 1 });
    });
  });

  test("a rate limit is retried with backoff: the marks stay, the next drain waits, a new change retries at once", async () => {
    await withRollback(async (tx) => {
      const { skuA, staffId } = await pushable(tx);
      const fake = fakeTikTok();
      fake.reply = (call) => (call.productId === "p1" ? { status: 429, body: { code: 36009002, message: "slow down", request_id: "r" } } : null);
      const counts = await pushTikTokStockNow(tx, deps(fake));
      expect(counts).toMatchObject({ failed: 1, pushed: 1 });
      expect(counts!.problems).toContainEqual({ id: "p1", code: "rate_limited" });
      expect(await marks(tx, skuA)).not.toHaveLength(0);
      const [retry] = await tx.select().from(tiktokStockPushRetries).where(eq(tiktokStockPushRetries.variantSku, skuA));
      expect(retry).toMatchObject({ attempts: 1, lastErrorCode: "rate_limited" });
      const [{ gap }] = (await tx.execute<{ gap: number }>(sql`select extract(epoch from next_attempt_at - now())::int as gap from tiktok_stock_push_retries where variant_sku = ${skuA}`)) as unknown as [{ gap: number }];
      expect(gap).toBe(60);
      // Not due yet: nothing to do.
      expect(await pushTikTokStockNow(tx, deps(fake))).toBeNull();
      // Due again: the second failure doubles the wait.
      await tx.execute(sql`update tiktok_stock_push_retries set next_attempt_at = now() - interval '1 second', updated_at = now() - interval '1 minute'`);
      await pushTikTokStockNow(tx, deps(fake));
      const [second] = (await tx.execute<{ attempts: number; gap: number }>(sql`select attempts, extract(epoch from next_attempt_at - now())::int as gap from tiktok_stock_push_retries where variant_sku = ${skuA}`)) as unknown as [{ attempts: number; gap: number }];
      expect(second).toEqual({ attempts: 2, gap: 120 });
      // While TikTok is rate limiting, a new change does NOT skip the backoff (a checkout burst never
      // hammers a throttling TikTok).
      fake.reply = () => null;
      await tx.execute(sql`alter table tiktok_stock_push_retries disable trigger set_updated_at`);
      await tx.execute(sql`update tiktok_stock_push_retries set updated_at = now() - interval '2 minutes'`);
      await adjustStock({ sku: skuA, deltaQty: -1, reason: "damaged" }, staffId, tx);
      expect(await pushTikTokStockNow(tx, deps(fake))).toBeNull();
      // After another kind of failure at least a minute old, a real change is tried at once; success
      // clears the retry.
      await tx.execute(sql`update tiktok_stock_push_retries set last_error_code = 'unavailable', updated_at = now() - interval '2 minutes'`);
      await tx.execute(sql`alter table tiktok_stock_push_retries enable trigger set_updated_at`);
      expect(await pushTikTokStockNow(tx, deps(fake))).toMatchObject({ pushed: 1 });
      expect(await tx.select().from(tiktokStockPushRetries)).toHaveLength(0);
      expect(await marks(tx, skuA)).toHaveLength(0);
    });
  });

  test("R7 at push time: a second listing mapped to the same variant since the read holds both, nothing sent", async () => {
    await withRollback(async (tx) => {
      const { skuA, connectionId, staffId } = await pushable(tx);
      await storeTikTokListingProduct(tx, { connectionId, product: product("p3", [{ id: "s-a2", sellerSku: "LAIN" }]), ownWarehouses: OWN, readAt: await dbNow(tx) });
      // The read stored s-a2 unmapped; since then a manual mapping points it at A as well, and the row
      // shows it mapped with no hold (the read's own R7 has not run yet).
      await tx.insert(tiktokSkuMappings).values({ tiktokSkuId: "s-a2", variantSku: skuA, source: "manual", mappedByStaffUserId: staffId });
      await tx.update(tiktokListingSkus).set({ variantSku: skuA, holdReason: null }).where(eq(tiktokListingSkus.tiktokSkuId, "s-a2"));
      const fake = fakeTikTok();
      const counts = await pushTikTokStockNow(tx, deps(fake));
      const sent = fake.calls.flatMap((call) => call.body.skus.map((sku) => sku.id));
      expect(sent).not.toContain("s-a");
      expect(sent).not.toContain("s-a2");
      expect(sent).toContain("s-b");
      expect(counts!.held).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("review fixes (S2 code review, 28 Nov 2026)", () => {
  test("a mark with a LOWER id that becomes visible during the call survives (ids are given at insert, not at commit)", async () => {
    await withRollback(async (tx) => {
      const { skuA } = await pushable(tx);
      const fake = fakeTikTok();
      // While TikTok answers, a slower writer's mark appears with an id below every mark the push read.
      fake.reply = (call) => {
        if (call.productId === "p1") {
          tx.execute(sql`insert into tiktok_stock_outbox (id, variant_sku, source) overriding system value values (-1, ${skuA}, 'stock')`).catch((error: unknown) => {
            console.error("test insert failed", error);
          });
        }
        return null;
      };
      await pushTikTokStockNow(tx, deps(fake));
      expect((await marks(tx, skuA)).map((row) => row.id)).toEqual([-1]);
    });
  });

  test("a product that throws (a quantity TikTok cannot take) backs off instead of retrying every run", async () => {
    await withRollback(async (tx) => {
      const { skuA } = await pushable(tx);
      await tx.insert(stockMovements).values({ sku: skuA, qty: 1_000_000, valueAmount: 0, type: "production", refType: "manual" });
      const counts = await pushTikTokStockNow(tx, deps(fakeTikTok()));
      // Clamped to 999,999 by the target rule: sent, never thrown.
      expect(counts).toMatchObject({ errors: 0, pushed: 2 });
      // A real throw: an unusable warehouse id stored on the row.
      await tx.update(tiktokListingSkus).set({ warehouseId: "bad id" }).where(eq(tiktokListingSkus.tiktokSkuId, "s-a"));
      await adjustStock({ sku: skuA, deltaQty: -500_000, reason: "damaged" }, (await insertStaffUser(tx)).id, tx);
      const failing = await pushTikTokStockNow(tx, deps(fakeTikTok()));
      expect(failing).toMatchObject({ errors: 1 });
      const [retry] = await tx.select().from(tiktokStockPushRetries).where(eq(tiktokStockPushRetries.variantSku, skuA));
      expect(retry).toMatchObject({ attempts: 1, lastErrorCode: "Error" });
      expect(await pushTikTokStockNow(tx, deps(fakeTikTok()))).toBeNull();
    });
  });

  test("a complete read re-queues a pushable listing never pushed (a hold that cleared) and one whose re-read refusal it answers", async () => {
    await withRollback(async (tx) => {
      const { connectionId, skuA, skuB } = await pushable(tx);
      await clearMarks(tx);
      const passStart = await dbNow(tx);
      await tx.execute(sql`update tiktok_listing_skus set read_at = ${passStart.toISOString()}::timestamptz`);
      await tx.execute(sql`update tiktok_listing_skus set last_pushed_quantity = 3, last_pushed_at = now() - interval '1 hour', tiktok_quantity = 3, last_push_error_code = '12052901', last_push_error_at = now() - interval '30 minutes' where tiktok_sku_id = 's-b'`);
      expect(await queueTikTokListingDrift(tx, { connectionId, passStart })).toBe(2);
      expect(new Set((await marks(tx)).map((row) => row.variantSku))).toEqual(new Set([skuA, skuB]));
    });
  });

  test("the cron folds duplicate marks into one per variant; the push still sees the change", async () => {
    await withRollback(async (tx) => {
      const { skuA, staffId } = await pushable(tx);
      await clearMarks(tx);
      for (let i = 0; i < 5; i++) await adjustStock({ sku: skuA, deltaQty: -1, reason: "damaged" }, staffId, tx);
      const counts = emptyTikTokStockPushCounts();
      await prepareTikTokStockOutbox(tx, counts);
      expect(counts.compacted).toBeGreaterThanOrEqual(4);
      // One stock mark left (plus the hourly reconciliation's own, queued by the same upkeep).
      expect((await marks(tx, skuA)).filter((row) => row.source === "stock")).toHaveLength(1);
      const fake = fakeTikTok();
      await pushTikTokStockNow(tx, deps(fake));
      expect(fake.calls.flatMap((call) => call.body.skus).find((sku) => sku.id === "s-a")!.inventory[0]!.quantity).toBe(1);
    });
  });

  test("a closed gate is answered before any credential is loaded; refused SKUs are counted on every drain", async () => {
    await withRollback(async (tx) => {
      await pushable(tx);
      await tx.execute(sql`update tiktok_sync_cursors set last_error_code = 'budget_exhausted' where resource = 'products'`);
      // A keyring that cannot decrypt anything: loading credentials would fail.
      const broken = { ...deps(fakeTikTok()), keyring: { currentVersion: 9, keys: new Map() } as unknown as TokenKeyring };
      expect(await pushTikTokStockNow(tx, broken)).toMatchObject({ skipped: "listings_failing" });
      await tx.execute(sql`update tiktok_sync_cursors set last_error_code = null where resource = 'products'`);
      await tx.execute(sql`update tiktok_listing_skus set last_push_error_code = '12052393', last_push_error_at = now() where tiktok_sku_id = 's-b'`);
      const counts = await pushTikTokStockNow(tx, deps(fakeTikTok()));
      expect(counts).toMatchObject({ refusedSkus: 1 });
    });
  });
});

// ---- Inside the cron run ------------------------------------------------------------------------------

describe("runTikTokSync: the drain step", () => {
  test("hourly full reconciliation re-queues every mapped variant; the run pushes them; switch OFF purges the marks", async () => {
    await withRollback(async (tx) => {
      const { staffId, skuA } = await pushable(tx);
      // Listings fresh (not due), so the run makes no listing call; only orders polls and the push.
      const fake = fakeTikTok();
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.error).toBeNull();
      expect(summary.stockPush).toMatchObject({ skipped: null, pushed: 2, failed: 0 });
      expect(summary.stockPush.reconciled).toBeGreaterThanOrEqual(2);
      const [cursor] = await tx.select().from(tiktokSyncCursors).where(eq(tiktokSyncCursors.resource, "stock_push"));
      expect(cursor).toMatchObject({ lastErrorCode: null });
      expect(cursor?.lastOkAt).not.toBeNull();
      // Not due again within the hour.
      const again = await runTikTokSync(tx, deps(fake));
      expect(again.stockPush.reconciled).toBe(0);

      await setTikTokStockSync(tx, { enabled: false, staffUserId: staffId });
      await tx.insert(tiktokStockOutbox).values({ variantSku: skuA, source: "stock" });
      const off = await runTikTokSync(tx, deps(fake));
      expect(off.stockPush).toMatchObject({ skipped: "switch_off", purged: 1 });
      expect(await marks(tx)).toHaveLength(0);
    });
  });

  test("a retryable push failure is counted on the run (the route answers 500 → ALERT after 3) and recorded on the stock_push cursor", async () => {
    await withRollback(async (tx) => {
      await pushable(tx);
      const fake = fakeTikTok();
      fake.reply = () => ({ status: 503, body: { code: 1, message: "down", request_id: "r" } });
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.stockPush.failed).toBe(2);
      const [cursor] = await tx.select().from(tiktokSyncCursors).where(eq(tiktokSyncCursors.resource, "stock_push"));
      expect(cursor).toMatchObject({ lastOkAt: null, lastErrorCode: "unavailable" });
      expect(fake.paths.filter((path) => path.includes("inventory")).every((path) => !path.includes("s-x"))).toBe(true);
      expect(MIN).toBe(60_000);
    });
  });
});
