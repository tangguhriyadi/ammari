import { rmSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dropScratchDatabase, migrationsUpTo, recreateScratchDatabase, scratchUrl } from "./scratch-database";

// Migration 0065 (TikTok stock sync S2, docs/plans/tiktok-stock-sync.md §7): the dirty-variant outbox,
// its triggers, the retry table and two cursor resources. Upgrades a database at 0064 that already holds
// a connection with the stock switch ON and stock on a variant, then checks that the previous release's
// writes still work and that each of them leaves a mark (only while the switch is on). A disposable
// database of its own.

const SCRATCH_DATABASE = "ammari_scratch_migration_0065";

type Client = ReturnType<typeof postgres>;
let client: Client;
let upTo0064: string;
let upTo0065: string;
let connectionId: string;
let sku: string;
let orderId: string;
let orderItemId: string;

beforeAll(async () => {
  upTo0064 = migrationsUpTo(64);
  upTo0065 = migrationsUpTo(65);
  await recreateScratchDatabase(SCRATCH_DATABASE);
  client = postgres(scratchUrl(SCRATCH_DATABASE), { max: 2, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder: upTo0064 });
  const [connection] = await client`
    insert into tiktok_shop_connections (shop_id, shop_cipher, status, access_token_ct, refresh_token_ct, token_key_version, connected_at, orders_apply_enabled, stock_sync_enabled)
    values ('7000000000000000065', 'ROW_cipher', 'active', '\\x01'::bytea, '\\x02'::bytea, 1, now(), true, true) returning id`;
  connectionId = connection!.id as string;
  const [fabric] = await client`insert into fabrics (name) values ('Katun 0065') returning id`;
  const [color] = await client`insert into fabric_colors (fabric_id, name) values (${fabric!.id as string}, 'Hitam') returning id`;
  const [product] = await client`
    insert into products (name, code, slug, fabric_id, closure, size_mode, base_price)
    values ('Gamis 0065', 'G0065', 'gamis-0065', ${fabric!.id as string}, 'front_zip', 'sized', 259000) returning id`;
  sku = "G0065-HITAM-M";
  await client`insert into product_variants (sku, product_id, fabric_id, fabric_color_id, closure, size) values (${sku}, ${product!.id as string}, ${fabric!.id as string}, ${color!.id as string}, 'front_zip', 'M')`;
  await client`insert into stock_movements (sku, qty, value_amount, type, ref_type) values (${sku}, 5, 500000, 'production', 'manual')`;
  const [order] = await client`
    insert into orders (order_no, channel_id, channel_order_no, order_date, subtotal_amount, shipping_amount, discount_amount, total_amount)
    values ('ORD-TEST-0065', 'shopee', 'SHOPEE-0065', now(), 259000, 10000, 0, 269000) returning id`;
  orderId = order!.id as string;
  const [item] = await client`insert into order_items (order_id, sku, qty, unit_price, unit_cost) values (${orderId}, ${sku}, 1, 259000, 0) returning id`;
  orderItemId = item!.id as string;
  await migrate(drizzle(client), { migrationsFolder: upTo0065 });
}, 60_000);

afterAll(async () => {
  await client?.end();
  for (const dir of [upTo0064, upTo0065]) if (dir) rmSync(dir, { recursive: true, force: true });
  await dropScratchDatabase(SCRATCH_DATABASE);
});

async function marks(): Promise<{ variant_sku: string; source: string }[]> {
  return (await client`select variant_sku, source from tiktok_stock_outbox order by id`) as unknown as { variant_sku: string; source: string }[];
}

describe("0065 the outbox triggers on the previous release's writes", () => {
  test("a stock movement (the previous release's insert, unchanged) marks the variant in the same transaction", async () => {
    await client`delete from tiktok_stock_outbox`;
    await client`insert into stock_movements (sku, qty, value_amount, type, ref_type) values (${sku}, -1, -100000, 'sale', 'manual')`;
    expect(await marks()).toEqual([{ variant_sku: sku, source: "stock" }]);
    // Rolled back with its writer.
    await client.begin(async (tx) => {
      await tx`insert into stock_movements (sku, qty, value_amount, type, ref_type) values (${sku}, 1, 100000, 'return', 'manual')`;
      await tx`select 1/0`;
    }).catch(() => undefined);
    expect(await marks()).toHaveLength(1);
  });

  test("a checkout hold insert and its release mark the variant; an update that changes nothing relevant does not", async () => {
    await client`delete from tiktok_stock_outbox`;
    const [hold] = await client`insert into stock_reservations (order_id, order_item_id, sku, qty, expires_at) values (${orderId}, ${orderItemId}, ${sku}, 1, now() + interval '75 minutes') returning id`;
    await client`update stock_reservations set status = 'released', released_at = now() where id = ${hold!.id as string}`;
    expect((await marks()).map((row) => row.source)).toEqual(["hold", "hold"]);
  });

  test("mapping writes mark the old and the new variant", async () => {
    await client`delete from tiktok_stock_outbox`;
    await client`insert into tiktok_sku_mappings (tiktok_sku_id, variant_sku, source) values ('s-0065', ${sku}, 'auto_seller_sku')`;
    await client`update tiktok_sku_mappings set is_active = false where tiktok_sku_id = 's-0065'`;
    expect((await marks()).map((row) => row.source)).toEqual(["mapping", "mapping"]);
  });

  test("nothing is marked while no connection has the stock switch on (the previous release's 'Hentikan penerapan pesanan')", async () => {
    await client`update tiktok_shop_connections set orders_apply_enabled = false where id = ${connectionId}`;
    await client`delete from tiktok_stock_outbox`;
    await client`insert into stock_movements (sku, qty, value_amount, type, ref_type) values (${sku}, 1, 100000, 'return', 'manual')`;
    expect(await marks()).toEqual([]);
    await client`update tiktok_shop_connections set orders_apply_enabled = true, stock_sync_enabled = true where id = ${connectionId}`;
  });
});

describe("0065 tables and cursor", () => {
  test("outbox sources and retry attempts are checked", async () => {
    await expect(client`insert into tiktok_stock_outbox (variant_sku, source) values (${sku}, 'guess')`).rejects.toThrow(/tiktok_stock_outbox_source_check/);
    await expect(client`insert into tiktok_stock_push_retries (variant_sku, attempts, next_attempt_at, last_error_code) values (${sku}, 0, now(), 'rate_limited')`).rejects.toThrow(/attempts_check/);
    await client`insert into tiktok_stock_push_retries (variant_sku, attempts, next_attempt_at, last_error_code) values (${sku}, 1, now(), 'rate_limited')`;
  });

  test("the cursor accepts stock_push and stock_reconcile and still refuses an unknown resource", async () => {
    await client`insert into tiktok_sync_cursors (resource) values ('stock_push'), ('stock_reconcile')`;
    await expect(client`insert into tiktok_sync_cursors (resource) values ('stock')`).rejects.toThrow(/resource_check/);
  });
});
