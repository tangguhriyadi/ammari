import { rmSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dropScratchDatabase, migrationsUpTo, recreateScratchDatabase, scratchUrl } from "./scratch-database";

// Migration 0064 (TikTok stock sync S1, docs/plans/tiktok-stock-sync.md §3): the switch, rule R1 in the
// database (CHECK + trigger), the listing table and the `products` cursor. Upgrades a database at 0063
// that already holds a connection with applying ON, and checks that the previous release's writes still
// work and still keep R1. A disposable database of its own.

const SCRATCH_DATABASE = "ammari_scratch_migration_0064";

type Client = ReturnType<typeof postgres>;
let client: Client;
let upTo0063: string;
let upTo0064: string;
let connectionId: string;
let staffId: string;

beforeAll(async () => {
  upTo0063 = migrationsUpTo(63);
  upTo0064 = migrationsUpTo(64);
  await recreateScratchDatabase(SCRATCH_DATABASE);
  client = postgres(scratchUrl(SCRATCH_DATABASE), { max: 2, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder: upTo0063 });
  const [role] = await client`select id from roles limit 1`;
  const [staff] = await client`insert into staff_users (email, name, role_id) values ('stock-0064@e2e.ammari.test', 'Stock 0064', ${role!.id as string}) returning id`;
  staffId = staff!.id as string;
  const [connection] = await client`
    insert into tiktok_shop_connections (shop_id, shop_cipher, status, access_token_ct, refresh_token_ct, token_key_version, connected_at, orders_apply_enabled)
    values ('7000000000000000064', 'ROW_cipher', 'active', '\\x01'::bytea, '\\x02'::bytea, 1, now(), true) returning id`;
  connectionId = connection!.id as string;
  await migrate(drizzle(client), { migrationsFolder: upTo0064 });
}, 60_000);

afterAll(async () => {
  await client?.end();
  for (const dir of [upTo0063, upTo0064]) if (dir) rmSync(dir, { recursive: true, force: true });
  await dropScratchDatabase(SCRATCH_DATABASE);
});

async function flags() {
  const [row] = await client`select orders_apply_enabled, stock_sync_enabled, stock_sync_changed_by_staff_user_id as by from tiktok_shop_connections where id = ${connectionId}`;
  return row!;
}

describe("0064 stock switch and rule R1", () => {
  test("an existing connection reads stock sync OFF; it can be turned ON while applying is ON", async () => {
    expect(await flags()).toMatchObject({ orders_apply_enabled: true, stock_sync_enabled: false });
    await client`update tiktok_shop_connections set stock_sync_enabled = true where id = ${connectionId}`;
    expect(await flags()).toMatchObject({ stock_sync_enabled: true });
  });

  test("the previous release's 'Hentikan penerapan pesanan' (orders only) also turns stock OFF, naming who", async () => {
    await client`update tiktok_shop_connections set stock_sync_enabled = true, orders_apply_enabled = true where id = ${connectionId}`;
    await client`update tiktok_shop_connections set orders_apply_enabled = false, orders_apply_changed_at = now(), orders_apply_changed_by_staff_user_id = ${staffId} where id = ${connectionId}`;
    expect(await flags()).toMatchObject({ orders_apply_enabled: false, stock_sync_enabled: false, by: staffId });
  });

  test("stock ON while applying is OFF is refused (CHECK), never silently ignored", async () => {
    await client`update tiktok_shop_connections set orders_apply_enabled = false where id = ${connectionId}`;
    await expect(client`update tiktok_shop_connections set stock_sync_enabled = true where id = ${connectionId}`).rejects.toThrow(/tiktok_shop_connections_stock_sync_needs_orders_check/);
    await expect(client`update tiktok_shop_connections set stock_sync_enabled = true, orders_apply_enabled = false where id = ${connectionId}`).rejects.toThrow(/stock_sync_needs_orders/);
    await expect(
      client`insert into tiktok_shop_connections (shop_id, shop_cipher, status, token_key_version, connected_at, stock_sync_enabled) values ('7000000000000000065', 'c', 'disconnected', 1, now(), true)`,
    ).rejects.toThrow(/stock_sync_needs_orders/);
    expect(await flags()).toMatchObject({ stock_sync_enabled: false });
  });

  test("the previous release's connection insert (no stock column) still works and reads OFF", async () => {
    const [row] = await client`insert into tiktok_shop_connections (shop_id, shop_cipher, status, token_key_version, connected_at) values ('7000000000000000066', 'c', 'disconnected', 1, now()) returning stock_sync_enabled`;
    expect(row!.stock_sync_enabled).toBe(false);
  });
});

describe("0064 tiktok_listing_skus and the products cursor", () => {
  test("one row per (connection, TikTok SKU); quantities and hold reasons are checked", async () => {
    await client`insert into tiktok_listing_skus (connection_id, tiktok_sku_id, tiktok_product_id, product_status, read_at, tiktok_quantity) values (${connectionId}, 's1', 'p1', 'ACTIVATE', now(), 3)`;
    await expect(client`insert into tiktok_listing_skus (connection_id, tiktok_sku_id, tiktok_product_id, product_status, read_at) values (${connectionId}, 's1', 'p1', 'ACTIVATE', now())`).rejects.toThrow(/tiktok_listing_skus_connection_id_tiktok_sku_id_pk/);
    await expect(client`insert into tiktok_listing_skus (connection_id, tiktok_sku_id, tiktok_product_id, product_status, read_at, tiktok_quantity) values (${connectionId}, 's2', 'p1', 'ACTIVATE', now(), 1000000)`).rejects.toThrow(/quantity_check/);
    await expect(client`insert into tiktok_listing_skus (connection_id, tiktok_sku_id, tiktok_product_id, product_status, read_at, hold_reason) values (${connectionId}, 's3', 'p1', 'ACTIVATE', now(), 'guess')`).rejects.toThrow(/hold_reason_check/);
    await expect(client`insert into tiktok_listing_skus (connection_id, tiktok_sku_id, tiktok_product_id, product_status, read_at, last_pushed_quantity) values (${connectionId}, 's4', 'p1', 'ACTIVATE', now(), 2)`).rejects.toThrow(/pushed_check/);
  });

  test("the cursor accepts `products` and still refuses an unknown resource", async () => {
    await client`insert into tiktok_sync_cursors (resource) values ('products')`;
    await expect(client`insert into tiktok_sync_cursors (resource) values ('listings')`).rejects.toThrow(/resource_check/);
  });
});
