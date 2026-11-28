import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { productVariants, stockMovements, tiktokStockOutbox } from "@ammari/db/schema";
import { insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { dropScratchDatabase, openMigratedScratchDatabase, recreateScratchDatabase } from "@ammari/db/test-scratch";
import { Secret, createTikTokClient, type FetchLike, type TikTokAuthClient, type TokenKeyring } from "@ammari/tiktok-shop";
import { adjustStock } from "../stock/ledger";
import { setTikTokOrdersApply } from "./apply";
import { saveTikTokConnection } from "./connection";
import { setTikTokStockSync, storeTikTokListingProduct } from "./stock-sync";
import { pushTikTokStockNow } from "./sync";

// docs/plans/tiktok-stock-sync.md S2: two pushers of the same product never race. Real commits on real
// concurrent connections, so a disposable database of its own (ammari_scratch_*, never `ammari` or
// `ammari_test`). The fake TikTok holds the first Update Inventory call open while the second pusher
// starts: the advisory lock must keep the second one out until the first has written its result, and
// the second then sends only if the target changed meanwhile (the freshest compute wins).

const SCRATCH_DATABASE = "ammari_scratch_tiktok_stock_push";
const DAY = 86_400_000;
const KEYRING: TokenKeyring = { currentVersion: 1, keys: new Map([[1, new Secret(new Uint8Array(32).fill(7))]]) };

let scratch: Awaited<ReturnType<typeof openMigratedScratchDatabase>> | undefined;
let db: Awaited<ReturnType<typeof openMigratedScratchDatabase>>["db"];
let skuA: string;
let staffId: string;

beforeAll(async () => {
  await recreateScratchDatabase(SCRATCH_DATABASE);
  scratch = await openMigratedScratchDatabase(SCRATCH_DATABASE);
  db = scratch.db;

  const staff = await insertStaffUser(db);
  staffId = staff.id;
  const now = Date.now();
  const saved = await saveTikTokConnection(db, {
    tokens: {
      accessToken: new Secret("ROW_access_conc"),
      accessTokenExpiresAt: new Date(now + 7 * DAY),
      refreshToken: new Secret("ROW_refresh_conc"),
      refreshTokenExpiresAt: new Date(now + 60 * DAY),
      grantedScopes: ["seller.order.info", "seller.product.basic", "seller.logistics", "seller.product.write"],
      sellerName: "Ammari",
      sellerBaseRegion: "ID",
    },
    shop: { shopId: "7495540735365777777", shopCipher: "ROW_cipher", shopName: "Ammari", region: "ID", sellerType: "LOCAL" },
    staffUserId: staff.id,
    keyring: KEYRING,
    now: new Date(now - DAY),
  });
  if (!saved.ok) throw new Error(saved.reason);
  const { variant } = await insertProductVariant(db);
  skuA = variant.sku.toUpperCase();
  await db.update(productVariants).set({ sku: skuA }).where(eq(productVariants.sku, variant.sku));
  await db.insert(stockMovements).values({ sku: skuA, qty: 6, valueAmount: 600_000, type: "production", refType: "manual" });
  await storeTikTokListingProduct(db, {
    connectionId: saved.connectionId,
    product: { productId: "p1", status: "ACTIVATE", title: "Gamis p1", skus: [{ skuId: "s-a", sellerSku: skuA, label: null, inventory: [{ warehouse_id: "wh-own", quantity: 2 }] }], skuCount: 1, invalidSkus: 0 },
    ownWarehouses: new Set(["wh-own"]),
    readAt: new Date(),
  });
  await db.execute(sql`insert into tiktok_sync_cursors (resource, last_ok_at, last_run_at) values ('products', now(), now())`);
  expect(await setTikTokOrdersApply(db, { enabled: true, staffUserId: staff.id })).toMatchObject({ ok: true });
  expect(await setTikTokStockSync(db, { enabled: true, staffUserId: staff.id })).toMatchObject({ ok: true, changed: true });
}, 120_000);

afterAll(async () => {
  await scratch?.end();
  await dropScratchDatabase(SCRATCH_DATABASE);
});

const refusingAuth: TikTokAuthClient = {
  getAccessToken: async () => {
    throw new Error("test: no token exchange expected");
  },
  refreshAccessToken: async () => {
    throw new Error("test: no refresh expected");
  },
};

/** A fake TikTok whose first inventory call waits until `release()`. */
function blockingTikTok() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const firstArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const state = { inFlight: 0, maxInFlight: 0, quantities: [] as number[] };
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    if (!url.pathname.endsWith("/inventory/update")) throw new Error(`test: unexpected ${url.pathname}`);
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const body = JSON.parse(String(init.body)) as { skus: { inventory: { quantity: number }[] }[] };
    state.quantities.push(body.skus[0]!.inventory[0]!.quantity);
    if (state.quantities.length === 1) {
      arrived();
      await released;
    }
    state.inFlight -= 1;
    return new Response(JSON.stringify({ code: 0, message: "Success", request_id: "fake", data: {} }), { status: 200 });
  };
  const api = createTikTokClient({ appKey: new Secret("dummyappkey"), appSecret: new Secret("dummyappsecret0123456789"), baseUrl: "https://tiktok.test", fetch, sleep: async () => {} });
  return { deps: { api, auth: refusingAuth, keyring: KEYRING }, release, firstArrived, state };
}

describe("per-product serialisation (pg_advisory_xact_lock)", () => {
  test("two pushers at once → one call; the second waits for the first's result and finds the target unchanged", async () => {
    const fake = blockingTikTok();
    const first = pushTikTokStockNow(db, fake.deps);
    await fake.firstArrived;
    const second = pushTikTokStockNow(db, fake.deps);
    // Give the second pusher time to reach the lock (it must not reach TikTok).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.state.quantities).toEqual([6]);
    fake.release();
    const [a, b] = await Promise.all([first, second]);
    expect(fake.state.maxInFlight).toBe(1);
    expect(fake.state.quantities).toEqual([6]);
    expect((a?.pushed ?? 0) + (b?.pushed ?? 0)).toBe(1);
    expect(await db.select().from(tiktokStockOutbox)).toHaveLength(0);
  });

  test("a sale committed while the first call is in flight: the second pusher sends the fresh target, and no mark is lost", async () => {
    const fake = blockingTikTok();
    await adjustStock({ sku: skuA, deltaQty: 1, reason: "other" }, staffId, db); // 7 now: a push is due
    const first = pushTikTokStockNow(db, fake.deps);
    await fake.firstArrived;
    await adjustStock({ sku: skuA, deltaQty: -3, reason: "damaged" }, staffId, db); // committed: 4
    const second = pushTikTokStockNow(db, fake.deps);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.state.quantities).toEqual([7]);
    fake.release();
    await Promise.all([first, second]);
    expect(fake.state.maxInFlight).toBe(1);
    // The second pusher recomputed after the first had written its result: the last write TikTok saw is
    // the freshest compute, and every mark (the first's and the sale's) is gone.
    expect(fake.state.quantities).toEqual([7, 4]);
    expect(await db.select().from(tiktokStockOutbox)).toHaveLength(0);
  });
});
