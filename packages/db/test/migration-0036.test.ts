import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0036 (per-product discount, docs/plans/product-discount.md §4): adds products.discount_*
// and order_items.list_unit_price with their CHECKs. Upgrades a database sitting at 0035 with a
// product and an order line, then checks that existing rows get no discount, that the previous
// release's writes (which never name the new columns) keep working, and that re-running the
// migrator is a no-op. The CHECK rules themselves are covered by product-discount.test.ts.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0036_upgrade";

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

describe("migration 0036 (product discount)", () => {
  test("adds the discount columns, keeps rows, and leaves the previous release's writes working", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0035 = migrationsUpTo(35);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0035 });

      // State at 0035: a product with one variant, and an order line for it.
      const [fabric] = await client`insert into fabrics (name) values ('Katun Rayon') returning id`;
      const [color] = await client`insert into fabric_colors (fabric_id, name) values (${fabric!.id}, 'Black') returning id`;
      const [product] = await client`
        insert into products (name, code, slug, fabric_id, closure, size_mode, base_price)
        values ('Gamis Lama', 'LAMA', 'gamis-lama', ${fabric!.id}, 'front_zip', 'sized', 350000) returning id`;
      await client`
        insert into product_variants (sku, product_id, fabric_id, fabric_color_id, closure, size)
        values ('LAMA-BLK-M', ${product!.id}, ${fabric!.id}, ${color!.id}, 'front_zip', 'M')`;
      const [order] = await client`
        insert into orders (channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, discount_amount, total_amount)
        values ('web', 'ORD-202611-0001', now(), 'to_ship', 350000, 0, 0, 350000) returning id`;
      await client`insert into order_items (order_id, sku, qty, unit_price, unit_cost) values (${order!.id}, 'LAMA-BLK-M', 1, 350000, 0)`;

      await migrate(drizzle(client), { migrationsFolder });

      const [kept] = await client`
        select base_price, discount_price_amount, discount_enabled, discount_starts_at, discount_ends_at from products where id = ${product!.id}`;
      expect(kept).toEqual({
        base_price: "350000",
        discount_price_amount: null,
        discount_enabled: false,
        discount_starts_at: null,
        discount_ends_at: null,
      });
      const [line] = await client`select unit_price, list_unit_price from order_items where order_id = ${order!.id}`;
      expect(line).toEqual({ unit_price: "350000", list_unit_price: null });

      // The previous release's writes, which never name the new columns: a product edit (incl. its
      // base price), a new product, and a new order line.
      await client`update products set base_price = 360000, updated_at = now() where id = ${product!.id}`;
      await client`
        insert into products (name, code, slug, fabric_id, closure, size_mode, base_price)
        values ('Gamis Baru', 'BARU', 'gamis-baru', ${fabric!.id}, 'front_zip', 'sized', 299000)`;
      const [other] = await client`
        insert into orders (channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, discount_amount, total_amount)
        values ('web', 'ORD-202611-0002', now(), 'to_ship', 360000, 0, 0, 360000) returning id`;
      await client`insert into order_items (order_id, sku, qty, unit_price, unit_cost) values (${other!.id}, 'LAMA-BLK-M', 1, 360000, 0)`;

      // The new rules are live on the upgraded database.
      await client`update products set discount_price_amount = 279000, discount_enabled = true where id = ${product!.id}`;
      await expect(client`update products set base_price = 280000 where id = ${product!.id}`).rejects.toThrow(
        /products_discount_price_amount_check/,
      );

      // Re-running the migrator applies nothing and changes nothing.
      const before = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      await migrate(drizzle(client), { migrationsFolder });
      const after = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(after).toEqual(before);
    } finally {
      await client.end();
      rmSync(upTo0035, { recursive: true, force: true });
    }
  });
});
