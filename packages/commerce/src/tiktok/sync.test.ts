import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { auditLog, marketplaceRefunds, orderItems, orders, productVariants, stockMovements, tiktokBackfills, tiktokOrderSnapshots, tiktokOrders, tiktokReturns, tiktokShopConnections, tiktokSkuMappings, tiktokSyncCursors, tiktokWebhookEvents } from "@ammari/db/schema";
import { insertOrder, insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { Secret, createTikTokClient, projectTikTokOrder, type FetchLike, type TikTokAuthClient, type TikTokOrderProjection, type TikTokTokenSet, type TokenKeyring } from "@ammari/tiktok-shop";
import { purgeTikTokBuyerMessages } from "../maintenance/retention";
import { applyTikTokOrder, setTikTokOrdersApply } from "./apply";
import { confirmTikTokBackfill, getTikTokBackfillPreview, getTikTokBackfillView, startTikTokBackfill } from "./backfill";
import { createOrder, transitionOrderStatus } from "../orders/lifecycle";
import { saveTikTokConnection } from "./connection";
import { listTikTokOrderPreviews } from "./order-preview";
import { ingestTikTokOrder } from "./order-store";
import { TIKTOK_POLL_LAG_MS, TIKTOK_POLL_OVERLAP_MS } from "./order-windows";
import { listTikTokSkuMappings, listUnmappedTikTokSkus, mapTikTokSku, unmapTikTokSku } from "./sku-mappings";
import { drainTikTokWebhookOrderEvent, runTikTokSync } from "./sync";
import { parseTikTokWebhookBody, recordTikTokWebhookEvent } from "./webhook";

// docs/plans/tiktok-shop-integration.md T4 against a real database (each test rolls back) and an
// in-memory TikTok: snapshots and the forward-only projection, buyer_message only on the projection
// and its purge, the SKU mapping (1 TikTok SKU → 1 variant, exact auto-map), and the sync run (cursor,
// overlap, pagination, boundary duplicates, 429/503, time budget, inbox drain, topic 6/7 retries).
// Read side only: no test here expects an admin order or a stock row to change. Dummy tokens only.

const NOW = new Date("2026-11-27T03:00:00.000Z");
const DAY = 86_400_000;
const MIN = 60_000;
const SHOP_ID = "7495540735365777507";
const KEYRING: TokenKeyring = { currentVersion: 1, keys: new Map([[1, new Secret(new Uint8Array(32).fill(9))]]) };
const BUYER_PHONE = "+6281299990000";

function tokens(): TikTokTokenSet {
  return {
    accessToken: new Secret("ROW_access_t4"),
    accessTokenExpiresAt: new Date(NOW.getTime() + 7 * DAY),
    refreshToken: new Secret("ROW_refresh_t4"),
    refreshTokenExpiresAt: new Date(NOW.getTime() + 60 * DAY),
    grantedScopes: ["seller.order.info"],
    sellerName: "Ammari",
    sellerBaseRegion: "ID",
  };
}

async function connect(db: TestDatabase): Promise<string> {
  const staff = await insertStaffUser(db);
  const result = await saveTikTokConnection(db, { tokens: tokens(), shop: { shopId: SHOP_ID, shopCipher: "ROW_cipher", shopName: "Ammari", region: "ID", sellerType: "LOCAL" }, staffUserId: staff.id, keyring: KEYRING, now: new Date(NOW.getTime() - DAY) });
  if (!result.ok) throw new Error(result.reason);
  return result.connectionId;
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

function rawOrder(id: string, updateTime: Date, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: "AWAITING_SHIPMENT",
    update_time: seconds(updateTime),
    paid_time: seconds(updateTime) - 60,
    buyer_message: `pesan ${id}`,
    recipient_address: { phone_number: BUYER_PHONE, name: "Pembeli Rahasia" },
    payment: { currency: "IDR", sub_total: "259000", total_amount: "259000" },
    line_items: [{ id: `${id}-li`, sku_id: `sku-${id}`, seller_sku: `TT-${id}`, product_name: "Gamis", original_price: "259000" }],
    ...extra,
  };
}

function project(raw: unknown): TikTokOrderProjection {
  const result = projectTikTokOrder(raw);
  if (!result.ok) throw new Error("projection failed");
  return result.order;
}

async function projection(db: TestDatabase, id: string) {
  const [row] = await db.select().from(tiktokOrders).where(eq(tiktokOrders.tiktokOrderId, id));
  return row;
}

async function snapshotCount(db: TestDatabase, id: string) {
  return (await db.select({ id: tiktokOrderSnapshots.id }).from(tiktokOrderSnapshots).where(eq(tiktokOrderSnapshots.tiktokOrderId, id))).length;
}

// ---- In-memory TikTok -----------------------------------------------------------------------

interface FakeTikTok {
  fetch: FetchLike;
  orders: Map<string, Record<string, unknown>>;
  /** T6: requests by id, answered by Search Returns / Search Cancellations. */
  returns: Map<string, Record<string, unknown>>;
  cancellations: Map<string, Record<string, unknown>>;
  afterSaleSearches: { path: string; body: Record<string, unknown> }[];
  searches: { ge: number; lt: number; pageToken: string | null }[];
  detailCalls: string[][];
  /** Replies served before normal behaviour (status + envelope). */
  failures: { status: number; body: unknown; headers?: Record<string, string> }[];
  /** Advanced by every request (the shared fake clock). */
  clock: { ms: number };
  msPerRequest: number;
}

const PAGE_SIZE = 2;

function fakeTikTok(clock: { ms: number }): FakeTikTok {
  const fake: FakeTikTok = {
    orders: new Map(),
    returns: new Map(),
    cancellations: new Map(),
    afterSaleSearches: [],
    searches: [],
    detailCalls: [],
    failures: [],
    clock,
    msPerRequest: 0,
    fetch: async (input, init) => {
      const url = new URL(input);
      fake.clock.ms += fake.msPerRequest;
      const failure = fake.failures.shift();
      if (failure) return new Response(JSON.stringify(failure.body), { status: failure.status, headers: failure.headers });
      const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: "Success", request_id: "fake", data }), { status: 200 });
      if (url.pathname === "/order/202309/orders/search") {
        const body = JSON.parse(String(init.body)) as { update_time_ge: number; update_time_lt: number };
        const pageToken = url.searchParams.get("page_token");
        fake.searches.push({ ge: body.update_time_ge, lt: body.update_time_lt, pageToken });
        const matching = [...fake.orders.values()]
          .filter((order) => (order.update_time as number) >= body.update_time_ge && (order.update_time as number) < body.update_time_lt)
          .sort((a, b) => (a.update_time as number) - (b.update_time as number) || String(a.id).localeCompare(String(b.id)));
        // Tokens carry +, / and =, so a missing percent-encoding would break the next page.
        const offset = pageToken ? Number(Buffer.from(pageToken.replace(/^p\+\//, ""), "base64").toString()) : 0;
        const page = matching.slice(offset, offset + PAGE_SIZE);
        // Each page boundary repeats its last order on the next page (TikTok can do this when an
        // order changes during pagination): a boundary duplicate.
        const nextOffset = offset + PAGE_SIZE - 1;
        const next = offset + PAGE_SIZE < matching.length ? `p+/${Buffer.from(String(nextOffset)).toString("base64")}` : "";
        return ok({ orders: page.map((order) => ({ id: order.id, recipient_address: { phone_number: BUYER_PHONE } })), next_page_token: next });
      }
      if (url.pathname === "/return_refund/202309/returns/search" || url.pathname === "/return_refund/202309/cancellations/search") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        fake.afterSaleSearches.push({ path: url.pathname, body });
        const isReturn = url.pathname.includes("/returns/");
        const store = isReturn ? fake.returns : fake.cancellations;
        const matching = [...store.values()].filter((record) =>
          Array.isArray(body.order_ids) ? (body.order_ids as string[]).includes(String(record.order_id)) : (record.update_time as number) >= (body.update_time_ge as number) && (record.update_time as number) < (body.update_time_lt as number),
        );
        return ok({ [isReturn ? "return_orders" : "cancellations"]: matching, next_page_token: "" });
      }
      // T9: empty finance lists, for tests whose connection holds seller.finance.info.
      if (url.pathname === "/finance/202507/orders/unsettled") return ok({ transactions: [], next_page_token: "" });
      if (url.pathname === "/finance/202309/statements") return ok({ statements: [], next_page_token: "" });
      if (url.pathname === "/finance/202309/payments") return ok({ payments: [], next_page_token: "" });
      if (url.pathname === "/order/202507/orders") {
        const ids = (url.searchParams.get("ids") ?? "").split(",");
        fake.detailCalls.push(ids);
        return ok({ orders: ids.map((id) => fake.orders.get(id)).filter(Boolean) });
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

function deps(fake: FakeTikTok) {
  const api = createTikTokClient({
    appKey: new Secret("dummyappkey"),
    appSecret: new Secret("dummyappsecret0123456789"),
    baseUrl: "https://tiktok.test",
    fetch: fake.fetch,
    now: () => fake.clock.ms,
    sleep: async (ms) => {
      fake.clock.ms += ms;
    },
    random: () => 0,
  });
  return { api, auth: refusingAuth, keyring: KEYRING, now: () => new Date(fake.clock.ms) };
}

async function cursor(db: TestDatabase) {
  const [row] = await db.select().from(tiktokSyncCursors).where(eq(tiktokSyncCursors.resource, "orders"));
  return row;
}

async function setCursor(db: TestDatabase, windowEnd: Date) {
  await db.insert(tiktokSyncCursors).values({ resource: "orders", windowEnd }).onConflictDoUpdate({ target: tiktokSyncCursors.resource, set: { windowEnd } });
}

// ---- Snapshots and projection -----------------------------------------------------------------

describe("ingestTikTokOrder", () => {
  test("the same snapshot twice is one row; the projection holds the buyer message and the snapshot never does", async () => {
    await withRollback(async (tx) => {
      const order = project(rawOrder("o-1", NOW));
      expect(await ingestTikTokOrder(tx, order, "poll", NOW)).toMatchObject({ snapshot: "inserted", projection: "created" });
      expect(await ingestTikTokOrder(tx, order, "webhook", NOW)).toMatchObject({ snapshot: "replay", projection: "unchanged" });
      expect(await snapshotCount(tx, "o-1")).toBe(1);
      const row = await projection(tx, "o-1");
      expect(row?.buyerMessage).toBe("pesan o-1");
      const [snapshot] = await tx.select().from(tiktokOrderSnapshots).where(eq(tiktokOrderSnapshots.tiktokOrderId, "o-1"));
      expect(JSON.stringify(snapshot!.payload)).not.toContain("pesan o-1");
      expect(JSON.stringify(snapshot!.payload)).not.toContain(BUYER_PHONE);
      // The inbox never holds it either (T3's allowlist).
      const parsed = parseTikTokWebhookBody(JSON.stringify({ type: 1, tts_notification_id: "n-bm", shop_id: SHOP_ID, timestamp: 1, data: { order_id: "o-1", buyer_message: "pesan o-1" } }));
      expect(parsed.ok && JSON.stringify(parsed.event.payload)).not.toContain("pesan");
    });
  });

  test("an older update_time after a newer one leaves the projection unchanged (but keeps the snapshot)", async () => {
    await withRollback(async (tx) => {
      await ingestTikTokOrder(tx, project(rawOrder("o-2", NOW, { status: "IN_TRANSIT", collection_time: seconds(NOW) })), "webhook", NOW);
      const late = await ingestTikTokOrder(tx, project(rawOrder("o-2", new Date(NOW.getTime() - 10 * MIN))), "poll", NOW);
      expect(late).toMatchObject({ snapshot: "inserted", projection: "unchanged" });
      const row = await projection(tx, "o-2");
      expect(row?.status).toBe("IN_TRANSIT");
      expect(row?.latestUpdateTime).toEqual(new Date(seconds(NOW) * 1000));
      expect(await snapshotCount(tx, "o-2")).toBe(2);
      // A newer one moves it forward.
      expect(await ingestTikTokOrder(tx, project(rawOrder("o-2", new Date(NOW.getTime() + MIN), { status: "DELIVERED" })), "poll", NOW)).toMatchObject({ projection: "advanced" });
      expect((await projection(tx, "o-2"))?.status).toBe("DELIVERED");
    });
  });

  test("the same update_time with different content is kept and flagged, never silently chosen", async () => {
    await withRollback(async (tx) => {
      await ingestTikTokOrder(tx, project(rawOrder("o-3", NOW)), "poll", NOW);
      const other = await ingestTikTokOrder(tx, project(rawOrder("o-3", NOW, { status: "ON_HOLD" })), "webhook", NOW);
      expect(other).toMatchObject({ snapshot: "conflict", projection: "unchanged" });
      const row = await projection(tx, "o-3");
      expect(row?.status).toBe("AWAITING_SHIPMENT");
      expect(row?.reviewFlags).toEqual(["tiktok_snapshot_conflict"]);
      expect(await snapshotCount(tx, "o-3")).toBe(2);
    });
  });

  test("buyer message: purge date at COMPLETED/CANCELLED + 30 days, purged then, kept at + 29 days, never for an open order, never re-stored", async () => {
    await withRollback(async (tx) => {
      // Terminal 31 days ago: purged. Terminal 29 days ago: kept. Open: kept.
      const old = new Date(Date.now() - 31 * DAY);
      const recent = new Date(Date.now() - 29 * DAY);
      await ingestTikTokOrder(tx, project(rawOrder("p-old", old, { status: "COMPLETED" })), "poll", old);
      await ingestTikTokOrder(tx, project(rawOrder("p-cancel", old, { status: "CANCELLED", cancel_time: seconds(old) })), "poll", old);
      await ingestTikTokOrder(tx, project(rawOrder("p-recent", recent, { status: "COMPLETED" })), "poll", recent);
      await ingestTikTokOrder(tx, project(rawOrder("p-open", old, { status: "IN_TRANSIT" })), "poll", old);
      expect((await projection(tx, "p-recent"))?.buyerMessagePurgeAfter).toEqual(new Date(seconds(recent) * 1000 + 30 * DAY));
      expect((await projection(tx, "p-open"))?.buyerMessagePurgeAfter).toBeNull();

      expect(await purgeTikTokBuyerMessages(tx)).toEqual({ purged: 2, truncated: false });
      expect((await projection(tx, "p-old"))?.buyerMessage).toBeNull();
      expect((await projection(tx, "p-cancel"))?.buyerMessage).toBeNull();
      expect((await projection(tx, "p-recent"))?.buyerMessage).toBe("pesan p-recent");
      expect((await projection(tx, "p-open"))?.buyerMessage).toBe("pesan p-open");

      // First seen already past its purge date (a late first poll): never stored at all.
      await ingestTikTokOrder(tx, project(rawOrder("p-late", old, { status: "COMPLETED" })), "poll", new Date());
      expect((await projection(tx, "p-late"))?.buyerMessage).toBeNull();

      // A later version after the purge date never brings the message back.
      await ingestTikTokOrder(tx, project(rawOrder("p-old", new Date(), { status: "COMPLETED" })), "poll", new Date());
      expect((await projection(tx, "p-old"))?.buyerMessage).toBeNull();
      // Leaving a terminal status is flagged, and an open order is never purged.
      await ingestTikTokOrder(tx, project(rawOrder("p-recent", new Date(), { status: "IN_TRANSIT" })), "poll", new Date());
      const reopened = await projection(tx, "p-recent");
      expect(reopened?.reviewFlags).toEqual(["tiktok_left_terminal"]);
      await tx.update(tiktokOrders).set({ buyerMessagePurgeAfter: old }).where(eq(tiktokOrders.tiktokOrderId, "p-recent"));
      expect(await purgeTikTokBuyerMessages(tx)).toEqual({ purged: 0, truncated: false });
      expect((await projection(tx, "p-recent"))?.buyerMessage).toBe("pesan p-recent");
    });
  });
});

// ---- SKU mapping -------------------------------------------------------------------------------

describe("SKU mapping", () => {
  test("auto-maps an exact seller SKU (trimmed, any case) and never a near miss; audited without actor", async () => {
    await withRollback(async (tx) => {
      const { variant: inserted } = await insertProductVariant(tx);
      // Ammari SKUs are uppercase (generateSku); the fixture's is a lowercase uuid.
      const [variant] = await tx.update(productVariants).set({ sku: `POKA-${inserted.sku.slice(-8).toUpperCase()}-M` }).where(eq(productVariants.sku, inserted.sku)).returning();
      if (!variant) throw new Error("variant");
      const near = `${variant.sku.slice(0, -1)}${variant.sku.endsWith("A") ? "B" : "A"}`;
      const order = project(
        rawOrder("m-1", NOW, {
          line_items: [
            { sku_id: "tt-exact", product_id: "pp", seller_sku: `  ${variant.sku.toLowerCase()} `, original_price: "1" },
            { sku_id: "tt-near", seller_sku: near, original_price: "1" },
          ],
        }),
      );
      expect((await ingestTikTokOrder(tx, order, "poll", NOW)).autoMapped).toEqual(["tt-exact"]);
      const rows = await tx.select().from(tiktokSkuMappings);
      expect(rows.map((row) => [row.tiktokSkuId, row.variantSku, row.source, row.mappedByStaffUserId])).toEqual([["tt-exact", variant.sku, "auto_seller_sku", null]]);
      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.action, "tiktok_sku_auto_map"), eq(auditLog.entityId, "tt-exact")));
      expect(audit?.actorStaffUserId).toBeNull();
      // The near miss is listed as unmapped on the page, with its order.
      const unmapped = await listUnmappedTikTokSkus(tx);
      expect(unmapped.map((sku) => sku.tiktokSkuId)).toEqual(["tt-near"]);
      expect(unmapped[0]).toMatchObject({ sellerSku: near, orderCount: 1 });
    });
  });

  test("one TikTok SKU maps to one variant (PK), two TikTok SKUs may map to the same variant; map/unmap audited with the staff member", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const first = await insertProductVariant(tx);
      const second = await insertProductVariant(tx);
      await ingestTikTokOrder(tx, project(rawOrder("m-2", NOW, { line_items: [{ sku_id: "tt-a", seller_sku: "NOPE-1" }, { sku_id: "tt-b", seller_sku: "NOPE-2" }] })), "poll", NOW);
      expect((await listUnmappedTikTokSkus(tx)).map((sku) => sku.tiktokSkuId).sort()).toEqual(["tt-a", "tt-b"]);

      expect(await mapTikTokSku(tx, { tiktokSkuId: "tt-a", variantSku: first.variant.sku, staffUserId: staff.id })).toEqual({ ok: true, changed: true });
      expect(await mapTikTokSku(tx, { tiktokSkuId: "tt-b", variantSku: first.variant.sku, staffUserId: staff.id })).toEqual({ ok: true, changed: true });
      // Remapping replaces, never adds a second row for the same TikTok SKU.
      expect(await mapTikTokSku(tx, { tiktokSkuId: "tt-a", variantSku: second.variant.sku, staffUserId: staff.id })).toEqual({ ok: true, changed: true });
      const rows = await tx.select().from(tiktokSkuMappings);
      expect(rows.map((row) => [row.tiktokSkuId, row.variantSku]).sort()).toEqual([["tt-a", second.variant.sku], ["tt-b", first.variant.sku]].sort());
      await expect(tx.transaction((sp) => sp.insert(tiktokSkuMappings).values({ tiktokSkuId: "tt-a", variantSku: first.variant.sku, source: "auto_seller_sku" }))).rejects.toThrow();
      expect(await listUnmappedTikTokSkus(tx)).toEqual([]);
      expect((await listTikTokSkuMappings(tx)).map((row) => row.tiktokSkuId).sort()).toEqual(["tt-a", "tt-b"]);

      expect(await mapTikTokSku(tx, { tiktokSkuId: "tt-unseen", variantSku: first.variant.sku, staffUserId: staff.id })).toEqual({ ok: false, reason: "unknown_tiktok_sku" });
      expect(await mapTikTokSku(tx, { tiktokSkuId: "tt-a", variantSku: "NO-SUCH-SKU", staffUserId: staff.id })).toEqual({ ok: false, reason: "variant_not_found" });

      expect(await unmapTikTokSku(tx, { tiktokSkuId: "tt-b", staffUserId: staff.id })).toEqual({ ok: true });
      expect(await unmapTikTokSku(tx, { tiktokSkuId: "tt-b", staffUserId: staff.id })).toEqual({ ok: false, reason: "not_mapped" });
      expect((await listUnmappedTikTokSkus(tx)).map((sku) => sku.tiktokSkuId)).toEqual(["tt-b"]);

      const audits = await tx.select({ action: auditLog.action, actor: auditLog.actorStaffUserId }).from(auditLog).where(eq(auditLog.entityType, "tiktok_sku_mapping"));
      expect(audits.filter((row) => row.action === "tiktok_sku_map")).toHaveLength(3);
      expect(audits.filter((row) => row.action === "tiktok_sku_unmap")).toEqual([{ action: "tiktok_sku_unmap", actor: staff.id }]);
    });
  });

  test("the dry-run preview holds an unmapped order and would create it once mapped; it writes nothing to orders", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const { variant } = await insertProductVariant(tx);
      await ingestTikTokOrder(tx, project(rawOrder("d-1", NOW)), "poll", NOW);
      const typed = await insertOrder(tx, { channelId: "tiktok", channelOrderNo: "d-2" });
      await ingestTikTokOrder(tx, project(rawOrder("d-2", NOW)), "poll", NOW);
      let preview = await listTikTokOrderPreviews(tx);
      expect(preview.rows.find((row) => row.tiktokOrderId === "d-1")?.outcome).toEqual({ kind: "held", reason: "unknown_sku", detail: "sku-d-1" });
      await mapTikTokSku(tx, { tiktokSkuId: "sku-d-1", variantSku: variant.sku, staffUserId: staff.id });
      await mapTikTokSku(tx, { tiktokSkuId: "sku-d-2", variantSku: variant.sku, staffUserId: staff.id });
      preview = await listTikTokOrderPreviews(tx);
      expect(preview.rows.find((row) => row.tiktokOrderId === "d-1")?.outcome).toEqual({ kind: "create", reviewPartialShipping: false });
      expect(preview.rows.find((row) => row.tiktokOrderId === "d-2")?.outcome).toEqual({ kind: "update", reviewPartialShipping: false });
      expect((await projection(tx, "d-2"))?.orderId).toBeNull();
      expect((await tx.select().from(tiktokOrders)).every((row) => row.orderId === null)).toBe(true);
      void typed;
    });
  });
});

// ---- The sync run -------------------------------------------------------------------------------

describe("runTikTokSync", () => {
  test("polls the window, follows every page (encoded token), stores each order once despite boundary duplicates, then advances the cursor", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const clock = { ms: NOW.getTime() };
      const fake = fakeTikTok(clock);
      const windowEnd = new Date(NOW.getTime() - 30 * MIN);
      await setCursor(tx, windowEnd);
      for (let index = 0; index < 5; index += 1) {
        const id = `w-${index}`;
        fake.orders.set(id, rawOrder(id, new Date(NOW.getTime() - (20 - index) * MIN)));
      }
      // Updated inside the overlap: found again, stored once (replay).
      fake.orders.set("w-overlap", rawOrder("w-overlap", new Date(windowEnd.getTime() - 2 * MIN)));
      await ingestTikTokOrder(tx, project(fake.orders.get("w-overlap")), "poll", NOW);

      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.error).toBeNull();
      expect(summary.connection).toBe("active");
      expect(summary.poll).toMatchObject({ slices: 1, slicesDone: 1, caughtUp: true });
      // Both bounds, overlap ≥ 5 minutes, lag 2 minutes.
      expect(fake.searches[0]).toMatchObject({ ge: seconds(new Date(windowEnd.getTime() - TIKTOK_POLL_OVERLAP_MS)), lt: seconds(new Date(NOW.getTime() - TIKTOK_POLL_LAG_MS)), pageToken: null });
      expect(fake.searches.length).toBeGreaterThan(2);
      expect(fake.searches.slice(1).every((search) => search.pageToken?.startsWith("p+/"))).toBe(true);
      // Each order fetched in detail once, despite the repeated boundary ids.
      const fetched = fake.detailCalls.flat();
      expect(new Set(fetched).size).toBe(fetched.length);
      expect(fetched.sort()).toEqual(["w-0", "w-1", "w-2", "w-3", "w-4", "w-overlap"]);
      expect(summary.orders).toMatchObject({ fetched: 6, snapshotsInserted: 5, replays: 1 });
      expect((await cursor(tx))?.windowEnd).toEqual(new Date(seconds(new Date(NOW.getTime() - TIKTOK_POLL_LAG_MS)) * 1000));
      const [connection] = await tx.select().from(tiktokShopConnections);
      expect(connection?.lastPollOkAt).toEqual(NOW);
      // Read side only: nothing reached admin orders.
      expect((await tx.select().from(tiktokOrders)).every((row) => row.orderId === null && row.applyState === null)).toBe(true);

      // A second run starts 5 minutes before the new cursor.
      clock.ms += 5 * MIN;
      fake.searches.length = 0;
      await runTikTokSync(tx, deps(fake));
      expect(fake.searches[0]!.ge).toBe(seconds(new Date(NOW.getTime() - TIKTOK_POLL_LAG_MS - TIKTOK_POLL_OVERLAP_MS)));
    });
  });

  test("a failure mid-slice leaves the cursor where it was: 429 → rate_limited, 503 → unavailable", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const clock = { ms: NOW.getTime() };
      const fake = fakeTikTok(clock);
      const windowEnd = new Date(NOW.getTime() - 30 * MIN);
      await setCursor(tx, windowEnd);
      for (let index = 0; index < 3; index += 1) fake.orders.set(`r-${index}`, rawOrder(`r-${index}`, new Date(NOW.getTime() - (10 - index) * MIN)));

      // First page fine, then TikTok rate limits for good (5 tries).
      const rateLimited = { body: { code: 36009002, message: "rate", request_id: "rl" } };
      const realFetch = fake.fetch;
      let calls = 0;
      fake.fetch = async (input, init) => {
        calls += 1;
        // search page 1 + detail ok; then every call is a 429.
        if (calls > 2) {
          return new Response(JSON.stringify(rateLimited.body), { status: 429 });
        }
        return realFetch(input, init);
      };
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.error).toEqual({ kind: "rate_limited", code: "rate_limited:36009002" });
      expect((await cursor(tx))?.windowEnd).toEqual(windowEnd);
      expect((await cursor(tx))?.lastErrorCode).toBe("rate_limited:36009002");
      const [connection] = await tx.select().from(tiktokShopConnections);
      expect(connection?.lastErrorCode).toBe("rate_limited:36009002");
      expect(connection?.lastPollOkAt).toBeNull();

      // 503 every time: 2 short retries, then unavailable; cursor still unchanged.
      const fake503 = fakeTikTok({ ms: NOW.getTime() });
      fake503.failures.push(...Array.from({ length: 3 }, () => ({ status: 503, body: {} })));
      const unavailable = await runTikTokSync(tx, deps(fake503));
      expect(unavailable.error?.kind).toBe("unavailable");
      expect((await cursor(tx))?.windowEnd).toEqual(windowEnd);
    });
  });

  test("the time budget: no new TikTok call after it; the cursor keeps the last finished slice", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const clock = { ms: NOW.getTime() };
      const fake = fakeTikTok(clock);
      // Four slices of up to 6 h; every request costs 60 s of the 150-s budget.
      const windowEnd = new Date(NOW.getTime() - 21 * 60 * MIN);
      await setCursor(tx, windowEnd);
      fake.msPerRequest = 60_000;
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.budgetExhausted).toBe(true);
      expect(summary.error).toBeNull();
      expect(summary.poll.slicesDone).toBeGreaterThan(0);
      expect(summary.poll.slicesDone).toBeLessThan(summary.poll.slices);
      // The run ended right after the call that crossed 150 s: never a call started after it.
      expect(fake.searches).toHaveLength(summary.poll.slicesDone);
      expect(clock.ms - NOW.getTime()).toBeLessThan(150_000 + 60_000);
      const stored = await cursor(tx);
      expect(stored?.windowEnd?.getTime()).toBe(windowEnd.getTime() - TIKTOK_POLL_OVERLAP_MS + summary.poll.slicesDone * 6 * 60 * MIN);
    });
  });

  test("an order listed but not returned in detail holds the cursor and fails the run loudly, with its id", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const clock = { ms: NOW.getTime() };
      const fake = fakeTikTok(clock);
      const windowEnd = new Date(NOW.getTime() - 30 * MIN);
      await setCursor(tx, windowEnd);
      fake.orders.set("g-1", rawOrder("g-1", new Date(NOW.getTime() - 20 * MIN)));
      fake.orders.set("g-2", rawOrder("g-2", new Date(NOW.getTime() - 19 * MIN)));
      const realFetch = fake.fetch;
      // Detail leaves g-2 out (TikTok's detail lagging its search index).
      fake.fetch = async (input, init) => {
        const url = new URL(input);
        if (url.pathname === "/order/202507/orders") {
          url.searchParams.set("ids", (url.searchParams.get("ids") ?? "").split(",").filter((id) => id !== "g-2").join(","));
          return realFetch(url.toString(), init);
        }
        return realFetch(input, init);
      };
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.error).toEqual({ kind: "incomplete", code: "order_missing" });
      expect(summary.problems).toEqual([{ id: "g-2", problem: "order_missing" }]);
      expect(summary.orders).toMatchObject({ fetched: 1, missing: 1 });
      expect((await cursor(tx))?.windowEnd).toEqual(windowEnd);
      expect((await cursor(tx))?.lastErrorCode).toBe("order_missing");
      // g-1 is stored all the same; the next run (detail answering again) moves on.
      expect(await snapshotCount(tx, "g-1")).toBe(1);
      fake.fetch = realFetch;
      expect((await runTikTokSync(tx, deps(fake))).error).toBeNull();
      expect((await cursor(tx))?.windowEnd?.getTime()).toBeGreaterThan(windowEnd.getTime());
    });
  });

  test("an order TikTok returns without a usable update_time holds the cursor (order_invalid)", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const fake = fakeTikTok({ ms: NOW.getTime() });
      const windowEnd = new Date(NOW.getTime() - 30 * MIN);
      await setCursor(tx, windowEnd);
      fake.orders.set("v-1", rawOrder("v-1", new Date(NOW.getTime() - 20 * MIN)));
      const realFetch = fake.fetch;
      fake.fetch = async (input, init) => {
        const response = await realFetch(input, init);
        if (new URL(input).pathname !== "/order/202507/orders") return response;
        const body = (await response.json()) as { data: { orders: Record<string, unknown>[] } };
        body.data.orders = body.data.orders.map((order) => ({ ...order, update_time: "soon" }));
        return new Response(JSON.stringify(body), { status: 200 });
      };
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.error).toEqual({ kind: "incomplete", code: "order_invalid" });
      expect((await cursor(tx))?.windowEnd).toEqual(windowEnd);
    });
  });

  test("not connected: nothing is called", async () => {
    await withRollback(async (tx) => {
      const fake = fakeTikTok({ ms: NOW.getTime() });
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.connection).toBe("not_connected");
      expect(fake.searches).toHaveLength(0);
    });
  });

  test("inbox: topics 1/11/12 re-fetch their order (body not trusted), are marked processed; a failure is retried with backoff", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const clock = { ms: NOW.getTime() };
      const fake = fakeTikTok(clock);
      await setCursor(tx, new Date(NOW.getTime() - 3 * MIN));
      fake.orders.set("i-1", rawOrder("i-1", new Date(NOW.getTime() - 60 * MIN), { status: "IN_TRANSIT" }));
      const record = async (type: number, id: string, orderId: string | undefined, status = "AWAITING_SHIPMENT") => {
        const parsed = parseTikTokWebhookBody(JSON.stringify({ type, tts_notification_id: id, shop_id: SHOP_ID, timestamp: seconds(NOW), data: { order_id: orderId, order_status: status } }));
        if (!parsed.ok) throw new Error(parsed.reason);
        const stored = await recordTikTokWebhookEvent(tx, parsed.event);
        if (stored.kind !== "stored") throw new Error(stored.kind);
        return stored.id;
      };
      const one = await record(1, "n-1", "i-1", "COMPLETED");
      const eleven = await record(11, "n-11", "i-1");
      const noOrder = await record(12, "n-12", undefined);
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.inbox).toMatchObject({ claimed: 3, processed: 2, ignored: 1 });
      expect(summary.problems).toEqual([]);
      // One detail call for both events of the same order; the stored status is TikTok's, not the body's.
      expect(fake.detailCalls[0]).toEqual(["i-1"]);
      expect((await projection(tx, "i-1"))?.status).toBe("IN_TRANSIT");
      const events = await tx.select().from(tiktokWebhookEvents);
      expect(events.find((event) => event.id === one)?.status).toBe("processed");
      expect(events.find((event) => event.id === eleven)?.status).toBe("processed");
      expect(events.find((event) => event.id === noOrder)).toMatchObject({ status: "ignored", lastErrorCode: "no_order_id" });
      const [snapshot] = await tx.select().from(tiktokOrderSnapshots).where(eq(tiktokOrderSnapshots.tiktokOrderId, "i-1"));
      expect(snapshot?.source).toBe("webhook");

      // An order TikTok does not return: retried with its reason, never settled as done.
      const ghost = await record(1, "n-ghost", "i-ghost");
      const ghostRun = await runTikTokSync(tx, deps(fakeTikTok({ ms: NOW.getTime() })));
      expect(ghostRun.inbox.retried).toBe(1);
      const [ghostRow] = await tx.select().from(tiktokWebhookEvents).where(eq(tiktokWebhookEvents.id, ghost));
      expect(ghostRow).toMatchObject({ status: "pending", attempts: 1, lastErrorCode: "order_missing" });

      // A failing detail call: the event stays pending with attempts + 1 and a backoff.
      const failing = await record(1, "n-fail", "i-1");
      const broken = fakeTikTok({ ms: NOW.getTime() });
      broken.failures.push({ status: 400, body: { code: 12345, message: "bad", request_id: "b" } });
      const failed = await runTikTokSync(tx, deps(broken));
      expect(failed.error).toEqual({ kind: "api", code: "api:12345" });
      expect(failed.inbox.retried).toBe(1);
      const [row] = await tx.select().from(tiktokWebhookEvents).where(eq(tiktokWebhookEvents.id, failing));
      expect(row).toMatchObject({ status: "pending", attempts: 1, lastErrorCode: "api:12345" });
      expect(row?.nextAttemptAt).toEqual(new Date(NOW.getTime() + MIN));
      // At its 10th attempt it is failed.
      await tx.update(tiktokWebhookEvents).set({ attempts: 9, nextAttemptAt: null }).where(eq(tiktokWebhookEvents.id, failing));
      const brokenAgain = fakeTikTok({ ms: NOW.getTime() });
      brokenAgain.failures.push({ status: 400, body: { code: 12345, message: "bad", request_id: "b" } });
      expect((await runTikTokSync(tx, deps(brokenAgain))).inbox.failed).toBe(1);
      const [final] = await tx.select().from(tiktokWebhookEvents).where(eq(tiktokWebhookEvents.id, failing));
      expect(final).toMatchObject({ status: "failed", attempts: 10 });
    });
  });

  test("the webhook's after() drain refreshes its one order; an event already claimed is not fetched twice", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const fake = fakeTikTok({ ms: NOW.getTime() });
      fake.orders.set("a-1", rawOrder("a-1", NOW));
      const parsed = parseTikTokWebhookBody(JSON.stringify({ type: 1, tts_notification_id: "n-a", shop_id: SHOP_ID, timestamp: seconds(NOW), data: { order_id: "a-1" } }));
      if (!parsed.ok) throw new Error(parsed.reason);
      const stored = await recordTikTokWebhookEvent(tx, parsed.event);
      if (stored.kind !== "stored") throw new Error(stored.kind);
      expect(await drainTikTokWebhookOrderEvent(tx, deps(fake), stored.id)).toMatchObject({ kind: "processed", apply: { enabled: false } });
      expect(await drainTikTokWebhookOrderEvent(tx, deps(fake), stored.id)).toEqual({ kind: "not_due" });
      expect(fake.detailCalls).toEqual([["a-1"]]);
      expect(await snapshotCount(tx, "a-1")).toBe(1);
    });
  });

  test("a due topic 6 retry is applied by the cron run (T3 left it to T4), which then stops: no TikTok call", async () => {
    await withRollback(async (tx) => {
      const connectionId = await connect(tx);
      const parsed = parseTikTokWebhookBody(JSON.stringify({ type: 6, tts_notification_id: "n-6", shop_id: SHOP_ID, timestamp: seconds(NOW) }));
      if (!parsed.ok) throw new Error(parsed.reason);
      const stored = await recordTikTokWebhookEvent(tx, parsed.event);
      if (stored.kind !== "stored") throw new Error(stored.kind);
      // Its first attempt failed earlier; the retry is due now.
      await tx.update(tiktokWebhookEvents).set({ attempts: 1, nextAttemptAt: new Date(NOW.getTime() - MIN), lastErrorCode: "pg:55P03" }).where(eq(tiktokWebhookEvents.id, stored.id));
      const fake = fakeTikTok({ ms: NOW.getTime() });
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.connectionEvents.processed).toBe(1);
      expect(summary.connection).toBe("not_connected");
      const [event] = await tx.select().from(tiktokWebhookEvents).where(eq(tiktokWebhookEvents.id, stored.id));
      expect(event?.status).toBe("processed");
      const [connection] = await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.id, connectionId));
      expect(connection?.status).toBe("deauthorized");
      expect(fake.searches).toHaveLength(0);
    });
  });
});

// ---- T5: applying, behind the kill switch -------------------------------------------------------

describe("runTikTokSync applying orders (T5)", () => {
  async function paidOrder(tx: TestDatabase, id: string, updateTime: Date, mapped = true) {
    const { variant } = await insertProductVariant(tx);
    if (mapped) await tx.insert(tiktokSkuMappings).values({ tiktokSkuId: `sku-${id}`, variantSku: variant.sku, source: "auto_seller_sku", sellerSku: variant.sku });
    await tx.insert(stockMovements).values({ sku: variant.sku, qty: 3, valueAmount: 300_000, type: "production", refType: "manual" });
    return {
      sku: variant.sku,
      raw: {
        ...rawOrder(id, updateTime, { paid_time: seconds(updateTime) - 2 * 3600 }),
        payment: { currency: "IDR", sub_total: "259000", seller_discount: "0", total_amount: "259000" },
        line_items: [{ id: `${id}-li`, sku_id: `sku-${id}`, seller_sku: variant.sku, product_name: "Gamis", original_price: "259000" }],
      },
    };
  }

  test("switch off (the default): a dry run, nothing reaches admin orders or stock", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const clock = { ms: NOW.getTime() };
      const fake = fakeTikTok(clock);
      await setCursor(tx, new Date(NOW.getTime() - 30 * MIN));
      const { raw } = await paidOrder(tx, "k-off", new Date(NOW.getTime() - 10 * MIN));
      fake.orders.set("k-off", raw);
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.apply).toMatchObject({ enabled: false, created: 0 });
      expect(await tx.select().from(orders).where(eq(orders.channelOrderNo, "k-off"))).toHaveLength(0);
      expect((await projection(tx, "k-off"))?.applyState).toBeNull();
    });
  });

  test("switch on: the stored order is applied (stock out); turned off again, the next run writes nothing", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const staff = await insertStaffUser(tx);
      expect(await setTikTokOrdersApply(tx, { enabled: true, staffUserId: staff.id })).toEqual({ ok: true, changed: true });
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.action, "tiktok_apply_enable"), eq(auditLog.actorStaffUserId, staff.id)));
      expect(audits).toHaveLength(1);
      const clock = { ms: NOW.getTime() };
      const fake = fakeTikTok(clock);
      await setCursor(tx, new Date(NOW.getTime() - 30 * MIN));
      const { raw, sku } = await paidOrder(tx, "k-on", new Date(NOW.getTime() - 10 * MIN));
      fake.orders.set("k-on", raw);
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.apply).toMatchObject({ enabled: true, created: 1, failed: 0 });
      const [order] = await tx.select().from(orders).where(and(eq(orders.channelId, "tiktok"), eq(orders.channelOrderNo, "k-on")));
      expect(order?.status).toBe("to_ship");
      const [{ qty } = { qty: 0 }] = await tx.execute<{ qty: number }>(sql`select coalesce(sum(qty), 0)::int as qty from stock_movements where sku = ${sku}`);
      expect(qty).toBe(2);

      expect(await setTikTokOrdersApply(tx, { enabled: false, staffUserId: staff.id })).toEqual({ ok: true, changed: true });
      const later = new Date(NOW.getTime() + 5 * MIN);
      fake.orders.set("k-on", { ...raw, status: "CANCELLED", update_time: seconds(later), cancel_time: seconds(later) });
      clock.ms += 10 * MIN;
      const off = await runTikTokSync(tx, deps(fake));
      expect(off.apply.enabled).toBe(false);
      const [still] = await tx.select().from(orders).where(eq(orders.id, order!.id));
      expect(still?.status).toBe("to_ship");
    });
  });

  test("the switch can always be turned off, even once the connection needs reconnecting; never turned on then", async () => {
    await withRollback(async (tx) => {
      const connectionId = await connect(tx);
      const staff = await insertStaffUser(tx);
      await setTikTokOrdersApply(tx, { enabled: true, staffUserId: staff.id });
      await tx.update(tiktokShopConnections).set({ status: "reauth_required" }).where(eq(tiktokShopConnections.id, connectionId));
      expect(await setTikTokOrdersApply(tx, { enabled: false, staffUserId: staff.id })).toEqual({ ok: true, changed: true });
      expect(await setTikTokOrdersApply(tx, { enabled: true, staffUserId: staff.id })).toEqual({ ok: false, reason: "not_connected" });
      const [row] = await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.id, connectionId));
      expect(row?.ordersApplyEnabled).toBe(false);
    });
  });

  test("a held order is re-checked (after its 15-minute back-off) without a TikTok call, and applied once its SKU is mapped", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const staff = await insertStaffUser(tx);
      await setTikTokOrdersApply(tx, { enabled: true, staffUserId: staff.id });
      const clock = { ms: NOW.getTime() };
      const fake = fakeTikTok(clock);
      await setCursor(tx, new Date(NOW.getTime() - 30 * MIN));
      const { raw, sku } = await paidOrder(tx, "k-held", new Date(NOW.getTime() - 10 * MIN), false);
      // No mapping yet: held as unknown_sku.
      fake.orders.set("k-held", raw);
      const first = await runTikTokSync(tx, deps(fake));
      expect(first.apply).toMatchObject({ held: 1 });
      expect(await projection(tx, "k-held")).toMatchObject({ applyState: "held", heldReason: "unknown_sku" });

      await tx.insert(tiktokSkuMappings).values({ tiktokSkuId: "sku-k-held", variantSku: sku, source: "manual", mappedByStaffUserId: staff.id });
      fake.orders.clear();
      fake.detailCalls.length = 0;
      // The next run, 5 minutes on: the hold backs off (15 minutes), nothing re-checked yet.
      clock.ms += 5 * MIN;
      expect((await runTikTokSync(tx, deps(fake))).apply).toMatchObject({ rechecked: 0, created: 0 });
      clock.ms += 11 * MIN;
      const second = await runTikTokSync(tx, deps(fake));
      expect(second.apply).toMatchObject({ rechecked: 1, created: 1 });
      expect(fake.detailCalls).toHaveLength(0);
      expect(await projection(tx, "k-held")).toMatchObject({ applyState: "applied" });
    });
  });
});

describe("runTikTokSync: cancellations and returns (T6)", () => {
  async function shippedOrder(tx: TestDatabase, id: string, updateTime: Date) {
    const { variant } = await insertProductVariant(tx);
    await tx.insert(tiktokSkuMappings).values({ tiktokSkuId: `sku-${id}`, variantSku: variant.sku, source: "auto_seller_sku", sellerSku: variant.sku });
    await tx.insert(stockMovements).values({ sku: variant.sku, qty: 3, valueAmount: 300_000, type: "production", refType: "manual" });
    return {
      sku: variant.sku,
      raw: {
        ...rawOrder(id, updateTime, { status: "DELIVERED", paid_time: seconds(updateTime) - 30 * 3600, collection_time: seconds(updateTime) - 20 * 3600 }),
        payment: { currency: "IDR", sub_total: "259000", seller_discount: "0", total_amount: "259000" },
        line_items: [{ id: `${id}-li`, sku_id: `sku-${id}`, seller_sku: variant.sku, product_name: "Gamis", original_price: "259000" }],
      },
    };
  }

  function refundOnly(orderId: string, requestId: string, updateTime: Date) {
    return {
      return_id: requestId,
      order_id: orderId,
      return_type: "REFUND",
      return_status: "RETURN_OR_REFUND_REQUEST_COMPLETE",
      create_time: seconds(updateTime) - 3600,
      update_time: seconds(updateTime),
      return_reason_text: "pesan rahasia pembeli",
      refund_amount: { currency: "IDR", refund_total: "59000" },
      return_line_items: [{ order_line_item_id: `${orderId}-li` }],
    };
  }

  async function afterSaleCursor(tx: TestDatabase, resource: "returns" | "cancellations") {
    const [row] = await tx.select().from(tiktokSyncCursors).where(eq(tiktokSyncCursors.resource, resource));
    return row;
  }

  test("switch on: the returns poll stores the request (no buyer text), fetches its order first, records the refund; both cursors advance", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const staff = await insertStaffUser(tx);
      await setTikTokOrdersApply(tx, { enabled: true, staffUserId: staff.id });
      const clock = { ms: NOW.getTime() };
      const fake = fakeTikTok(clock);
      await setCursor(tx, new Date(NOW.getTime() - 30 * MIN));
      for (const resource of ["returns", "cancellations"] as const) await tx.insert(tiktokSyncCursors).values({ resource, windowEnd: new Date(NOW.getTime() - 30 * MIN) });
      const { raw, sku } = await shippedOrder(tx, "r-1", new Date(NOW.getTime() - 20 * MIN));
      fake.orders.set("r-1", raw);
      fake.returns.set("rt-1", refundOnly("r-1", "rt-1", new Date(NOW.getTime() - 10 * MIN)));

      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.error).toBeNull();
      expect(summary.afterSales).toMatchObject({ fetched: 1, applied: 1, refundsRecorded: 1, failed: 0 });
      expect(summary.afterSales.poll.return).toMatchObject({ caughtUp: true, slicesDone: 1 });
      expect(summary.afterSales.poll.cancellation.caughtUp).toBe(true);
      const [order] = await tx.select().from(orders).where(and(eq(orders.channelId, "tiktok"), eq(orders.channelOrderNo, "r-1")));
      expect(order?.status).toBe("shipped");
      const refunds = await tx.select().from(marketplaceRefunds).where(eq(marketplaceRefunds.orderId, order!.id));
      expect(refunds).toMatchObject([{ amount: 59_000, kind: "refund_only", channelRefundId: "rt-1" }]);
      const [{ qty } = { qty: 0 }] = await tx.execute<{ qty: number }>(sql`select coalesce(sum(qty), 0)::int as qty from stock_movements where sku = ${sku}`);
      expect(qty).toBe(2);
      const snapshots = await tx.select().from(tiktokOrderSnapshots).where(and(eq(tiktokOrderSnapshots.tiktokOrderId, "r-1"), eq(tiktokOrderSnapshots.kind, "return")));
      expect(snapshots).toHaveLength(1);
      expect(JSON.stringify(snapshots[0]!.payload)).not.toContain("rahasia");
      for (const resource of ["returns", "cancellations"] as const) {
        const row = await afterSaleCursor(tx, resource);
        expect(row?.windowEnd?.getTime()).toBe(NOW.getTime() - TIKTOK_POLL_LAG_MS);
        expect(row?.lastOkAt).not.toBeNull();
      }
      // A second run: replayed, still one refund.
      clock.ms += 5 * MIN;
      const again = await runTikTokSync(tx, deps(fake));
      expect(again.afterSales.refundsRecorded).toBe(0);
      expect(await tx.select().from(marketplaceRefunds).where(eq(marketplaceRefunds.orderId, order!.id))).toHaveLength(1);
    });
  });

  test("switch off: the request is stored and listed, nothing reaches the order", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const clock = { ms: NOW.getTime() };
      const fake = fakeTikTok(clock);
      await setCursor(tx, new Date(NOW.getTime() - 30 * MIN));
      fake.returns.set("rt-off", refundOnly("r-off", "rt-off", new Date(NOW.getTime() - 10 * MIN)));
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.afterSales).toMatchObject({ fetched: 1, applied: 0 });
      const [row] = await tx.select().from(tiktokReturns).where(eq(tiktokReturns.requestId, "rt-off"));
      expect(row).toMatchObject({ state: null, status: "RETURN_OR_REFUND_REQUEST_COMPLETE", tiktokOrderId: "r-off" });
      expect(await tx.select().from(marketplaceRefunds).where(eq(marketplaceRefunds.channelRefundId, "rt-off"))).toHaveLength(0);
    });
  });

  test("a request TikTok returns without a usable id holds the returns cursor (incomplete)", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const clock = { ms: NOW.getTime() };
      const fake = fakeTikTok(clock);
      await setCursor(tx, new Date(NOW.getTime() - 30 * MIN));
      await tx.insert(tiktokSyncCursors).values({ resource: "returns", windowEnd: new Date(NOW.getTime() - 30 * MIN) });
      fake.returns.set("bad", { ...refundOnly("r-bad", "x", new Date(NOW.getTime() - 10 * MIN)), return_id: undefined });
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.error).toEqual({ kind: "incomplete", code: "order_invalid" });
      expect((await afterSaleCursor(tx, "returns"))?.windowEnd?.getTime()).toBe(NOW.getTime() - 30 * MIN);
    });
  });

  test("a failing cancellation search never settles a return event of the same batch", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const clock = { ms: NOW.getTime() };
      const fake = fakeTikTok(clock);
      await setCursor(tx, new Date(NOW.getTime() - 3 * MIN));
      for (const id of ["f-a", "f-b"]) fake.orders.set(id, (await shippedOrder(tx, id, new Date(NOW.getTime() - 60 * MIN))).raw);
      const ids: string[] = [];
      for (const [type, id, orderId] of [[11, "n-fa", "f-a"], [12, "n-fb", "f-b"]] as const) {
        const parsed = parseTikTokWebhookBody(JSON.stringify({ type, tts_notification_id: id, shop_id: SHOP_ID, timestamp: seconds(NOW), data: { order_id: orderId } }));
        if (!parsed.ok) throw new Error(parsed.reason);
        const stored = await recordTikTokWebhookEvent(tx, parsed.event);
        if (stored.kind !== "stored") throw new Error(stored.kind);
        ids.push(stored.id);
      }
      // Detail call answers; the first after-sale search (cancellations) fails.
      const realFetch = fake.fetch;
      let failed = false;
      fake.fetch = async (input, init) => {
        if (!failed && new URL(input).pathname.includes("/cancellations/search")) {
          failed = true;
          return new Response(JSON.stringify({ code: 12345, message: "bad", request_id: "b" }), { status: 400 });
        }
        return realFetch(input, init);
      };
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.error).toEqual({ kind: "api", code: "api:12345" });
      const events = await tx.select().from(tiktokWebhookEvents).where(inArray(tiktokWebhookEvents.id, ids));
      expect(events.map((event) => event.status)).toEqual(["pending", "pending"]);
    });
  });

  test("a stuck returns slice holds only its own cursor: the cancellations poll still runs and advances", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const clock = { ms: NOW.getTime() };
      const fake = fakeTikTok(clock);
      await setCursor(tx, new Date(NOW.getTime() - 30 * MIN));
      for (const resource of ["returns", "cancellations"] as const) await tx.insert(tiktokSyncCursors).values({ resource, windowEnd: new Date(NOW.getTime() - 30 * MIN) });
      fake.returns.set("bad", { ...refundOnly("s-1", "x", new Date(NOW.getTime() - 10 * MIN)), return_id: undefined });
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.error).toEqual({ kind: "incomplete", code: "order_invalid" });
      expect(summary.afterSales.poll.cancellation.caughtUp).toBe(true);
      expect((await afterSaleCursor(tx, "returns"))).toMatchObject({ windowEnd: new Date(NOW.getTime() - 30 * MIN), lastErrorCode: "order_invalid" });
      const cancellations = await afterSaleCursor(tx, "cancellations");
      expect(cancellations?.windowEnd?.getTime()).toBe(NOW.getTime() - TIKTOK_POLL_LAG_MS);
      expect(cancellations?.lastErrorCode).toBeNull();
      expect((await cursor(tx))?.lastErrorCode).toBeNull();
    });
  });

  test("topics 12 and 11 fetch the order's requests by order id; the events are processed", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const staff = await insertStaffUser(tx);
      await setTikTokOrdersApply(tx, { enabled: true, staffUserId: staff.id });
      const clock = { ms: NOW.getTime() };
      const fake = fakeTikTok(clock);
      await setCursor(tx, new Date(NOW.getTime() - 3 * MIN));
      const { raw } = await shippedOrder(tx, "w-1", new Date(NOW.getTime() - 60 * MIN));
      fake.orders.set("w-1", raw);
      fake.returns.set("rt-w", { ...refundOnly("w-1", "rt-w", new Date(NOW.getTime() - 60 * MIN)), return_status: "RETURN_OR_REFUND_REQUEST_PENDING" });
      fake.cancellations.set("c-w", { cancel_id: "c-w", order_id: "w-1", cancel_type: "BUYER_CANCEL", cancel_status: "CANCELLATION_REQUEST_CANCEL", create_time: seconds(NOW) - 4000, update_time: seconds(NOW) - 3600 });
      const ids: string[] = [];
      for (const [type, id] of [[12, "n-r"], [11, "n-c"]] as const) {
        const parsed = parseTikTokWebhookBody(JSON.stringify({ type, tts_notification_id: id, shop_id: SHOP_ID, timestamp: seconds(NOW), data: { order_id: "w-1" } }));
        if (!parsed.ok) throw new Error(parsed.reason);
        const stored = await recordTikTokWebhookEvent(tx, parsed.event);
        if (stored.kind !== "stored") throw new Error(stored.kind);
        ids.push(stored.id);
      }
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.inbox).toMatchObject({ claimed: 2, processed: 2 });
      expect(fake.afterSaleSearches.filter((search) => Array.isArray(search.body.order_ids))).toHaveLength(2);
      const rows = await tx.select().from(tiktokReturns).where(eq(tiktokReturns.tiktokOrderId, "w-1"));
      expect(rows.map((row) => [row.kind, row.state]).sort()).toEqual([
        ["cancellation", "closed"],
        ["return", "open"],
      ]);
      const [order] = await tx.select().from(orders).where(and(eq(orders.channelId, "tiktok"), eq(orders.channelOrderNo, "w-1")));
      expect(order?.needsAttention).toEqual(expect.arrayContaining(["marketplace_return_pending", "tiktok_return_response_due"]));
      const events = await tx.select().from(tiktokWebhookEvents).where(inArray(tiktokWebhookEvents.id, ids));
      expect(events.every((event) => event.status === "processed")).toBe(true);
    });
  });
});

// ---- T9: backfill in enrich mode --------------------------------------------------------------

describe("T9 backfill", () => {
  // December: a backfill never reaches before 1 Dec 2026 (TIKTOK_BACKFILL_FLOOR).
  const BNOW = new Date("2026-12-10T03:00:00.000Z");
  const DEC2 = new Date("2026-12-02T03:00:00.000Z");
  let next = 0;
  const tiktokId = () => `5779${String(Date.now()).slice(-8)}${String((next += 1)).padStart(6, "0")}`;

  async function connectAt(db: TestDatabase, scopes = ["seller.order.info", "seller.finance.info"]): Promise<string> {
    const staff = await insertStaffUser(db);
    const result = await saveTikTokConnection(db, {
      tokens: { ...tokens(), accessTokenExpiresAt: new Date(BNOW.getTime() + 7 * DAY), refreshTokenExpiresAt: new Date(BNOW.getTime() + 60 * DAY), grantedScopes: scopes },
      shop: { shopId: SHOP_ID, shopCipher: "ROW_cipher", shopName: "Ammari", region: "ID", sellerType: "LOCAL" },
      staffUserId: staff.id,
      keyring: KEYRING,
      now: new Date(BNOW.getTime() - DAY),
    });
    if (!result.ok) throw new Error(result.reason);
    // The live poll started yesterday: everything older is history for the backfill.
    await setCursor(db, new Date(BNOW.getTime() - 30 * MIN));
    return staff.id;
  }

  /** A mapped, stocked variant and a TikTok order on it (COMPLETED, shipped on `shippedAt`). */
  async function sold(tx: TestDatabase, id: string, updateTime: Date, extra: Record<string, unknown> = {}) {
    const { variant } = await insertProductVariant(tx);
    await tx.insert(tiktokSkuMappings).values({ tiktokSkuId: `sku-${id}`, variantSku: variant.sku, source: "auto_seller_sku", sellerSku: variant.sku });
    await tx.insert(stockMovements).values({ sku: variant.sku, qty: 3, valueAmount: 300_000, type: "production", refType: "manual" });
    const raw = {
      ...rawOrder(id, updateTime, { status: "COMPLETED", paid_time: seconds(updateTime) - 3 * DAY / 1000, collection_time: seconds(updateTime) - 2 * DAY / 1000, create_time: seconds(updateTime) - 3 * DAY / 1000 }),
      payment: { currency: "IDR", sub_total: "259000", seller_discount: "0", total_amount: "259000" },
      line_items: [{ id: `${id}-li`, sku_id: `sku-${id}`, seller_sku: variant.sku, product_name: "Gamis", original_price: "259000" }],
      ...extra,
    };
    return { sku: variant.sku, raw };
  }

  /** A hand-typed TikTok order. Typed before T9, a number keeps its separators: written as typed. */
  async function handTyped(tx: TestDatabase, staffId: string, channelOrderNo: string, sku: string) {
    const created = (await createOrder({ channelId: "tiktok", channelOrderNo: `LEGACY-${crypto.randomUUID()}`, orderDate: "2026-12-01", items: [{ sku, qty: 1, unitPrice: 259_000 }], discountAmount: 0, shippingAmount: 0, status: "to_ship" }, staffId, tx))!;
    const [row] = await tx.update(orders).set({ channelOrderNo }).where(eq(orders.id, created.id)).returning();
    return row!;
  }

  async function movementCount(tx: TestDatabase, orderId: string) {
    const items = await tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId));
    const rows = await tx.select().from(stockMovements).where(and(eq(stockMovements.refType, "order_item"), inArray(stockMovements.refId, items.map((item) => item.id))));
    return rows.length;
  }

  async function runUntilFetched(tx: TestDatabase, fake: FakeTikTok, runs = 5) {
    for (let run = 0; run < runs; run += 1) {
      const summary = await runTikTokSync(tx, deps(fake));
      if (summary.backfill.state === "fetched") return summary;
      fake.clock.ms += 5 * MIN;
    }
    throw new Error("backfill did not finish");
  }

  test("start: never before 1 Dec 2026, never today, one at a time, only while connected; audited with the staff member", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      expect(await startTikTokBackfill(tx, { fromDate: "2026-12-01", staffUserId: staff.id, now: BNOW })).toEqual({ ok: false, reason: "not_connected" });
      const staffId = await connectAt(tx);
      expect(await startTikTokBackfill(tx, { fromDate: "2026-11-30", staffUserId: staffId, now: BNOW })).toEqual({ ok: false, reason: "before_floor" });
      expect(await startTikTokBackfill(tx, { fromDate: "2026-12-10", staffUserId: staffId, now: BNOW })).toEqual({ ok: false, reason: "not_in_past" });
      const started = await startTikTokBackfill(tx, { fromDate: "2026-12-01", staffUserId: staffId, now: BNOW });
      expect(started).toMatchObject({ ok: true });
      expect(await startTikTokBackfill(tx, { fromDate: "2026-12-01", staffUserId: staffId, now: BNOW })).toEqual({ ok: false, reason: "already_open" });
      const view = await getTikTokBackfillView(tx);
      expect(view).toMatchObject({ state: "fetching", fromTime: new Date("2026-11-30T17:00:00.000Z"), untilTime: new Date(BNOW.getTime() - TIKTOK_POLL_LAG_MS) });
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.action, "tiktok_backfill_start"), eq(auditLog.actorStaffUserId, staffId)));
      expect(audits).toHaveLength(1);
      // The database refuses a range before the books start, whatever the caller.
      await expect(tx.transaction((sp) => sp.insert(tiktokBackfills).values({ fromTime: new Date("2026-11-30T16:59:59.000Z"), untilTime: BNOW, requestedByStaffUserId: staffId, requestedAt: BNOW, state: "confirmed", fetchedAt: BNOW, confirmedAt: BNOW, confirmedByStaffUserId: staffId }))).rejects.toThrow();
    });
  });

  test("the cron reads history into the backfill's own progress (live cursor untouched), stores it as backfill and gated; done → fetched, audited; a re-run reads nothing", async () => {
    await withRollback(async (tx) => {
      const staffId = await connectAt(tx);
      const clock = { ms: BNOW.getTime() };
      const fake = fakeTikTok(clock);
      const id = tiktokId();
      const { raw } = await sold(tx, id, DEC2);
      fake.orders.set(id, raw);
      await startTikTokBackfill(tx, { fromDate: "2026-12-01", staffUserId: staffId, now: BNOW });
      const liveBefore = (await cursor(tx))!.windowEnd;

      const summary = await runUntilFetched(tx, fake);
      expect(summary.backfill.orders.stored).toBeGreaterThanOrEqual(1);
      const row = await projection(tx, id);
      expect(row?.backfillId).toBe((await getTikTokBackfillView(tx))!.id);
      const [snapshot] = await tx.select().from(tiktokOrderSnapshots).where(eq(tiktokOrderSnapshots.tiktokOrderId, id));
      expect(snapshot?.source).toBe("backfill");
      // Every backfill search stays inside [1 Dec 00:00 WIB, until).
      const floor = seconds(new Date("2026-11-30T17:00:00.000Z"));
      expect(fake.searches.every((search) => search.ge >= floor - 300)).toBe(true);
      // The live poll's cursor is its own: the backfill never moves it back.
      expect((await cursor(tx))!.windowEnd!.getTime()).toBeGreaterThanOrEqual(liveBefore!.getTime());
      expect(await tx.select().from(auditLog).where(eq(auditLog.action, "tiktok_backfill_fetched"))).toHaveLength(1);

      fake.searches.length = 0;
      fake.detailCalls.length = 0;
      clock.ms += 5 * MIN;
      const again = await runTikTokSync(tx, deps(fake));
      expect(again.backfill.ran).toBe(false);
      expect(fake.searches.every((search) => search.ge >= seconds(BNOW) - 3600)).toBe(true);
    });
  });

  test("enrich: with applying on, matched hand-typed orders (also typed with spaces or #) wait for Terapkan riwayat; then linked, dated, moved forward, no duplicate and no extra stock movement; a missing one is created; a re-run writes nothing", async () => {
    await withRollback(async (tx) => {
      const staffId = await connectAt(tx);
      await setTikTokOrdersApply(tx, { enabled: true, staffUserId: staffId });
      const clock = { ms: BNOW.getTime() };
      const fake = fakeTikTok(clock);
      const exact = tiktokId();
      const spaced = tiktokId();
      const missing = tiktokId();
      const a = await sold(tx, exact, DEC2);
      const b = await sold(tx, spaced, DEC2);
      const c = await sold(tx, missing, DEC2);
      for (const [id, raw] of [[exact, a.raw], [spaced, b.raw], [missing, c.raw]] as const) fake.orders.set(id, raw);
      const typedExact = await handTyped(tx, staffId, exact, a.sku);
      const typedSpaced = await handTyped(tx, staffId, `#${spaced.slice(0, 6)} ${spaced.slice(6, 12)}-${spaced.slice(12)}`, b.sku);
      const movementsBefore = [await movementCount(tx, typedExact.id), await movementCount(tx, typedSpaced.id)];

      await startTikTokBackfill(tx, { fromDate: "2026-12-01", staffUserId: staffId, now: BNOW });
      const fetched = await runUntilFetched(tx, fake);
      // Gated: nothing reached admin yet, although applying is on.
      expect(fetched.apply.created).toBe(0);
      expect((await tx.select().from(orders).where(eq(orders.id, typedExact.id)))[0]).toMatchObject({ status: "to_ship", marketplaceShippedAt: null });
      expect(await tx.select().from(orders).where(eq(orders.channelOrderNo, missing))).toHaveLength(0);
      expect(await applyTikTokOrder(tx, exact, { now: new Date(clock.ms), source: "recheck" })).toEqual({ kind: "waiting_backfill" });

      expect(await confirmTikTokBackfill(tx, { staffUserId: staffId, now: new Date(clock.ms) })).toEqual({ ok: true, changed: true });
      expect(await tx.select().from(auditLog).where(and(eq(auditLog.action, "tiktok_backfill_confirm"), eq(auditLog.actorStaffUserId, staffId)))).toHaveLength(1);
      clock.ms += 5 * MIN;
      const applied = await runTikTokSync(tx, deps(fake));
      expect(applied.apply).toMatchObject({ created: 1, updated: 2, failed: 0 });

      for (const [typed, id] of [[typedExact, exact], [typedSpaced, spaced]] as const) {
        const [order] = await tx.select().from(orders).where(eq(orders.id, typed.id));
        expect(order).toMatchObject({ status: "completed", channelOrderNo: id, marketplaceShippedAt: new Date((seconds(DEC2) - 2 * 86_400) * 1000), channelStatus: "COMPLETED" });
        expect((await projection(tx, id))?.orderId).toBe(typed.id);
        expect(await tx.select().from(orders).where(and(eq(orders.channelId, "tiktok"), eq(orders.channelOrderNo, id)))).toHaveLength(1);
      }
      expect([await movementCount(tx, typedExact.id), await movementCount(tx, typedSpaced.id)]).toEqual(movementsBefore);
      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.action, "tiktok_update"), eq(auditLog.entityId, typedSpaced.id)));
      expect(audit?.before).toMatchObject({ channelOrderNo: typedSpaced.channelOrderNo });
      expect(audit?.after).toMatchObject({ channelOrderNo: spaced, source: "recheck" });
      expect(await tx.select().from(orders).where(and(eq(orders.channelId, "tiktok"), eq(orders.channelOrderNo, missing)))).toHaveLength(1);

      clock.ms += 5 * MIN;
      const replay = await runTikTokSync(tx, deps(fake));
      expect(replay.apply).toMatchObject({ created: 0, updated: 0 });
      expect(await confirmTikTokBackfill(tx, { staffUserId: staffId, now: new Date(clock.ms) })).toEqual({ ok: false, reason: "none" });
    });
  });

  test("two hand-typed orders with the same number (separators ignored) are held duplicate_in_admin and left untouched", async () => {
    await withRollback(async (tx) => {
      const staffId = await connectAt(tx);
      const id = tiktokId();
      const { raw, sku } = await sold(tx, id, DEC2);
      await tx.insert(stockMovements).values({ sku, qty: 3, valueAmount: 300_000, type: "production", refType: "manual" });
      const one = await handTyped(tx, staffId, `${id} `.replace(/^(\d{4})/, "$1 "), sku);
      const two = await handTyped(tx, staffId, `#${id}`, sku);
      await ingestTikTokOrder(tx, project(raw), "poll", BNOW);
      expect(await applyTikTokOrder(tx, id, { now: BNOW, source: "poll" })).toMatchObject({ kind: "held", reason: "duplicate_in_admin" });
      for (const typed of [one, two]) expect((await tx.select().from(orders).where(eq(orders.id, typed.id)))[0]).toMatchObject({ status: "to_ship", channelOrderNo: typed.channelOrderNo });
      expect(await tx.select().from(orders).where(and(eq(orders.channelId, "tiktok"), eq(orders.channelOrderNo, id)))).toHaveLength(0);

      // Staff cancel the wrong one: the other is matched (and its number corrected).
      await transitionOrderStatus(two.id, "cancelled", staffId, tx);
      await tx.execute(sql`update tiktok_orders set updated_at = updated_at - interval '1 hour' where tiktok_order_id = ${id}`);
      expect(await applyTikTokOrder(tx, id, { now: BNOW, source: "recheck" })).toMatchObject({ kind: "updated", orderId: one.id });
      expect((await tx.select().from(orders).where(eq(orders.id, one.id)))[0]).toMatchObject({ channelOrderNo: id, status: "completed" });
    });
  });

  test("a live update of an order the backfill stored first keeps it waiting for Terapkan riwayat; then its newest version applies", async () => {
    await withRollback(async (tx) => {
      const staffId = await connectAt(tx);
      await setTikTokOrdersApply(tx, { enabled: true, staffUserId: staffId });
      const clock = { ms: BNOW.getTime() };
      const fake = fakeTikTok(clock);
      const id = tiktokId();
      const { raw } = await sold(tx, id, DEC2, { status: "AWAITING_SHIPMENT", collection_time: undefined });
      fake.orders.set(id, raw);
      await startTikTokBackfill(tx, { fromDate: "2026-12-01", staffUserId: staffId, now: BNOW });
      await runUntilFetched(tx, fake);
      // TikTok ships it now: the live poll stores the new version, but the preview still holds it back.
      const shippedAt = new Date(clock.ms - 5 * MIN);
      fake.orders.set(id, { ...raw, status: "IN_TRANSIT", update_time: seconds(shippedAt), collection_time: seconds(shippedAt) });
      clock.ms += 5 * MIN;
      const live = await runTikTokSync(tx, deps(fake));
      expect(live.apply.created).toBe(0);
      expect((await projection(tx, id))).toMatchObject({ status: "IN_TRANSIT", backfillId: expect.any(String) });
      expect(await tx.select().from(orders).where(eq(orders.channelOrderNo, id))).toHaveLength(0);
      await confirmTikTokBackfill(tx, { staffUserId: staffId, now: new Date(clock.ms) });
      clock.ms += 5 * MIN;
      expect((await runTikTokSync(tx, deps(fake))).apply.created).toBe(1);
      expect((await tx.select().from(orders).where(eq(orders.channelOrderNo, id)))[0]?.status).toBe("shipped");
    });
  });

  test("hand entry of a TikTok number with spaces or # is stored as TikTok's digits, so an order the sync created is never typed in twice", async () => {
    await withRollback(async (tx) => {
      const staffId = await connectAt(tx);
      const id = tiktokId();
      const { raw, sku } = await sold(tx, id, DEC2);
      await ingestTikTokOrder(tx, project(raw), "poll", BNOW);
      expect(await applyTikTokOrder(tx, id, { now: BNOW, source: "poll" })).toMatchObject({ kind: "created" });
      await expect(createOrder({ channelId: "tiktok", channelOrderNo: `#${id.slice(0, 5)} ${id.slice(5)}`, orderDate: "2026-12-01", items: [{ sku, qty: 1, unitPrice: 1 }], discountAmount: 0, shippingAmount: 0, status: "awaiting_payment" }, staffId, tx)).rejects.toThrow(/sudah tercatat/);
      // Other channels and a number with letters are only trimmed.
      const typed = await createOrder({ channelId: "tiktok", channelOrderNo: " TT-123 ", orderDate: "2026-12-01", items: [{ sku, qty: 1, unitPrice: 1 }], discountAmount: 0, shippingAmount: 0, status: "awaiting_payment" }, staffId, tx);
      expect(typed?.channelOrderNo).toBe("TT-123");
    });
  });

  test("without the finance scope the backfill never marks statements and payouts done: it waits (finance_no_scope)", async () => {
    await withRollback(async (tx) => {
      const staffId = await connectAt(tx, ["seller.order.info"]);
      const clock = { ms: BNOW.getTime() };
      const fake = fakeTikTok(clock);
      await startTikTokBackfill(tx, { fromDate: "2026-12-01", staffUserId: staffId, now: BNOW });
      const summary = await runTikTokSync(tx, deps(fake));
      expect(summary.backfill).toMatchObject({ ran: true, state: "fetching", stoppedBy: "finance_no_scope", finance: { skipped: "no_scope" } });
      const view = await getTikTokBackfillView(tx);
      expect(view).toMatchObject({ state: "fetching", statementsDoneUntil: null, paymentsDoneUntil: null, lastErrorCode: "finance_no_scope" });
      expect(view?.ordersDoneUntil?.getTime()).toBe(view?.untilTime.getTime());
    });
  });

  test("a history slice that does not finish within its run is halved and repeated; the progress is kept, and the backfill finishes", async () => {
    await withRollback(async (tx) => {
      const staffId = await connectAt(tx);
      const clock = { ms: BNOW.getTime() };
      const fake = fakeTikTok(clock);
      // Many orders in the first six hours of 1 Dec, every request costs 4 s of the 150-s budget.
      const first = new Date("2026-11-30T18:00:00.000Z");
      for (let i = 0; i < 24; i += 1) {
        const id = tiktokId();
        fake.orders.set(id, { ...rawOrder(id, new Date(first.getTime() + i * 5 * MIN)), status: "CANCELLED" });
      }
      fake.msPerRequest = 4000;
      await startTikTokBackfill(tx, { fromDate: "2026-12-01", staffUserId: staffId, now: BNOW });
      const one = await runTikTokSync(tx, deps(fake));
      expect(one.backfill).toMatchObject({ ran: true, state: "fetching" });
      const view = await getTikTokBackfillView(tx);
      expect(view?.ordersSliceSeconds).toBeLessThan(6 * 3600);
      expect(view?.ordersDoneUntil?.getTime() ?? 0).toBeLessThanOrEqual(new Date("2026-11-30T23:00:00.000Z").getTime());
      let state = one.backfill.state;
      for (let run = 0; run < 40 && state !== "fetched"; run += 1) {
        clock.ms += 5 * MIN;
        state = (await runTikTokSync(tx, deps(fake))).backfill.state;
      }
      expect(state).toBe("fetched");
      expect(await tx.select().from(tiktokOrders)).toHaveLength(24);
    });
  });

  test("Terapkan riwayat is refused while history is still read; with applying off nothing reaches admin after it", async () => {
    await withRollback(async (tx) => {
      const staffId = await connectAt(tx);
      const clock = { ms: BNOW.getTime() };
      const fake = fakeTikTok(clock);
      const id = tiktokId();
      const { raw } = await sold(tx, id, DEC2);
      fake.orders.set(id, raw);
      await startTikTokBackfill(tx, { fromDate: "2026-12-01", staffUserId: staffId, now: BNOW });
      expect(await confirmTikTokBackfill(tx, { staffUserId: staffId, now: BNOW })).toEqual({ ok: false, reason: "still_fetching" });
      await runUntilFetched(tx, fake);
      expect(await confirmTikTokBackfill(tx, { staffUserId: staffId, now: new Date(clock.ms) })).toEqual({ ok: true, changed: true });
      clock.ms += 5 * MIN;
      const off = await runTikTokSync(tx, deps(fake));
      expect(off.apply).toMatchObject({ enabled: false, created: 0 });
      expect(await tx.select().from(orders).where(eq(orders.channelOrderNo, id))).toHaveLength(0);
    });
  });

  test("the preview: enrich (with what is filled), create (and shipped before the books start), held, skipped, and hand-typed orders TikTok did not return", async () => {
    await withRollback(async (tx) => {
      const staffId = await connectAt(tx);
      const clock = { ms: BNOW.getTime() };
      const fake = fakeTikTok(clock);
      const enrich = tiktokId();
      const create = tiktokId();
      const early = tiktokId();
      const held = tiktokId();
      const skipped = tiktokId();
      const e = await sold(tx, enrich, DEC2);
      // Shipped on 3 Dec: inside the books.
      const c = await sold(tx, create, new Date("2026-12-05T03:00:00.000Z"));
      // Paid and shipped in November, completed on 2 Dec: inside the window, shipped before the books start.
      const ea = await sold(tx, early, DEC2, { collection_time: seconds(new Date("2026-11-29T03:00:00.000Z")) });
      const h = await sold(tx, held, DEC2, { line_items: [{ id: `${held}-li`, sku_id: "sku-unmapped", seller_sku: "NOPE", original_price: "259000" }] });
      const s = await sold(tx, skipped, DEC2, { status: "CANCELLED", cancel_time: seconds(DEC2) });
      for (const [id, raw] of [[enrich, e.raw], [create, c.raw], [early, ea.raw], [held, h.raw], [skipped, s.raw]] as const) fake.orders.set(id, raw);
      const typed = await handTyped(tx, staffId, enrich, e.sku);
      const lonely = await handTyped(tx, staffId, "577900000000999999", c.sku);
      await startTikTokBackfill(tx, { fromDate: "2026-12-01", staffUserId: staffId, now: BNOW });
      await runUntilFetched(tx, fake);

      const preview = await getTikTokBackfillPreview(tx, new Date(clock.ms));
      expect(preview?.counts).toEqual({ enrich: 1, create: 2, held: 1, skip: 1, notInTikTok: 1 });
      const enriched = preview!.enrich.find((row) => row.tiktokOrderId === enrich);
      expect(enriched).toMatchObject({ orderId: typed.id, orderNo: typed.orderNo, statusFrom: "to_ship", statusTo: "completed", fillsShippedAt: true });
      expect(preview!.create.find((row) => row.tiktokOrderId === early)).toMatchObject({ shippedBeforeBooks: true });
      expect(preview!.create.find((row) => row.tiktokOrderId === create)).toMatchObject({ shippedBeforeBooks: false });
      expect(preview!.held).toEqual([expect.objectContaining({ tiktokOrderId: held, reason: "unknown_sku" })]);
      expect(preview!.skip).toEqual([expect.objectContaining({ tiktokOrderId: skipped, reason: "cancelled" })]);
      expect(preview!.notInTikTok).toEqual([expect.objectContaining({ orderId: lonely.id, channelOrderNo: "577900000000999999" })]);
      // Read only: nothing was written to admin.
      expect((await tx.select().from(orders).where(eq(orders.id, typed.id)))[0]?.status).toBe("to_ship");
    });
  });
});
