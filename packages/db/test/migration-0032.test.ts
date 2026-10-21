import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0032 (shipping provider area id, docs/plans/cart-checkout.md D18, session 8): renames
// shipping_areas.komerce_destination_id to provider_area_id and its UNIQUE to match. Upgrades a
// database sitting at 0031 with an area row (none exist in any real environment, but the rename
// must keep one if it did), a product with a weight and a cart, then checks the rename, that the
// key still refuses duplicates and serves the session 8 upsert, that the previous release's
// (session 7) writes keep working, and that re-running the migrator is a no-op.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0032_upgrade";

function urlFor(database: string): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const url = new URL(raw);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`Refusing to run migration tests against non-local host "${url.hostname}".`);
  }
  url.pathname = `/${database}`;
  return url.toString();
}

async function recreateDatabase(): Promise<void> {
  const admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DATABASE}`);
  } finally {
    await admin.end();
  }
}

function migrationsUpTo(lastIdx: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ammari-migrations-"));
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

afterAll(async () => {
  const admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`);
  } finally {
    await admin.end();
  }
});

describe("migration 0032 (shipping provider area id)", () => {
  test("renames the area key column and constraint, keeps rows, and leaves the previous release's writes working", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0031 = migrationsUpTo(31);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0031 });

      // State at 0031, written with the columns that release knows.
      const [fabric] = await client`insert into fabrics (name) values ('Katun Rayon') returning id`;
      const [color] = await client`insert into fabric_colors (fabric_id, name) values (${fabric!.id}, 'Black') returning id`;
      const [product] = await client`
        insert into products (name, code, slug, fabric_id, closure, size_mode, base_price, is_published_on_storefront, shipping_weight_grams)
        values ('Haura Dress', 'HAURA', 'haura-dress', ${fabric!.id}, 'front_zip', 'sized', 269000, true, 700) returning id`;
      await client`
        insert into product_variants (sku, product_id, fabric_id, fabric_color_id, closure, size)
        values ('HAURA-BLACK-M', ${product!.id}, ${fabric!.id}, ${color!.id}, 'front_zip', 'M')`;
      const [cart] = await client`insert into carts (token_hash) values ('hash-0032') returning id`;
      await client`insert into cart_items (cart_id, sku, qty) values (${cart!.id}, 'HAURA-BLACK-M', 1)`;
      await client`
        insert into shipping_areas (province, city, district, postal_code, search_text, label, komerce_destination_id)
        values ('DKI Jakarta', 'Jakarta Selatan', 'Pesanggrahan', '12250', 'pesanggrahan', 'Pesanggrahan, Jakarta Selatan, DKI Jakarta 12250', 'old-1')`;

      await migrate(drizzle(client), { migrationsFolder });

      // The column and the constraint carry the new names; the old ones are gone.
      const columns = await client`
        select column_name from information_schema.columns
        where table_name = 'shipping_areas' and column_name in ('komerce_destination_id', 'provider_area_id')`;
      expect(columns.map((row) => row.column_name)).toEqual(["provider_area_id"]);
      const constraints = await client`
        select conname from pg_constraint where conrelid = 'shipping_areas'::regclass and contype = 'u' order by conname`;
      expect(constraints.map((row) => row.conname)).toEqual(["shipping_areas_provider_area_id_key"]);

      // The existing row kept its id value.
      const [kept] = await client`select provider_area_id, district from shipping_areas`;
      expect(kept).toEqual({ provider_area_id: "old-1", district: "Pesanggrahan" });

      // Still the unique key, and still the session 8 upsert's ON CONFLICT target.
      await expect(client`
        insert into shipping_areas (province, city, district, postal_code, search_text, label, provider_area_id)
        values ('DKI Jakarta', 'Jakarta Selatan', 'Lain', '12260', 'lain', 'Lain', 'old-1')`).rejects.toThrow(
        /shipping_areas_provider_area_id_key/,
      );
      await client`
        insert into shipping_areas (province, city, district, postal_code, search_text, label, provider_area_id)
        values ('DKI Jakarta', 'Jakarta Selatan', 'Pesanggrahan', '12250', 'pesanggrahan baru', 'Baru', 'old-1')
        on conflict (provider_area_id) do update set label = excluded.label, last_synced_at = now()`;
      const [{ label }] = (await client`select label from shipping_areas where provider_area_id = 'old-1'`) as unknown as [{ label: string }];
      expect(label).toBe("Baru");

      // The previous release's (session 7) writes, which never touch shipping_areas: product
      // weight and publish, a manual order, and the cart.
      await client`update products set shipping_weight_grams = 750, is_published_on_storefront = true where id = ${product!.id}`;
      await client`
        insert into orders (channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, discount_amount, total_amount)
        values ('web', 'ORD-202610-0001', now(), 'awaiting_payment', 269000, 15000, 0, 284000)`;
      await client`
        insert into cart_items (cart_id, sku, qty) values (${cart!.id}, 'HAURA-BLACK-M', 2)
        on conflict (cart_id, sku) do update set qty = least(cart_items.qty + excluded.qty, 10)`;

      // Re-running the migrator applies nothing and changes nothing.
      const before = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      await migrate(drizzle(client), { migrationsFolder });
      const after = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(after).toEqual(before);
    } finally {
      await client.end();
      rmSync(upTo0031, { recursive: true, force: true });
    }
  });
});
