import { and, eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { auditLog, orders, productVariants, stockMovements, tiktokOrderSnapshots, tiktokOrders, tiktokShopConnections, tiktokSkuMappings, tiktokSyncCursors, tiktokWebhookEvents } from "@ammari/db/schema";
import { insertOrder, insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { Secret, createTikTokClient, projectTikTokOrder, type FetchLike, type TikTokAuthClient, type TikTokOrderProjection, type TikTokTokenSet, type TokenKeyring } from "@ammari/tiktok-shop";
import { purgeTikTokBuyerMessages } from "../maintenance/retention";
import { setTikTokOrdersApply } from "./apply";
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
