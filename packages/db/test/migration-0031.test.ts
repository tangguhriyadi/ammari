import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0031 (shipping quote, docs/plans/cart-checkout.md session 7): upgrades a database
// sitting at 0030 that already has a published product without a weight, orders (a marketplace
// order and a staff-entered `web` order) and a guest cart, then checks that nothing was
// unpublished or changed, that the previous release's own writes (session 6: admin product,
// storefront and order writes, cart writes) keep working against the new schema, that the
// shipping_areas keys were swapped, and that re-running the migrator is a no-op.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0031_upgrade";

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

describe("migration 0031 (shipping quote)", () => {
  test("keeps published products and orders as they were and leaves the previous release's writes working", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0030 = migrationsUpTo(30);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0030 });

      // State at 0030, written with the columns the previous release knows. "Haura Dress" stands
      // in for prod's published product, which has no weight.
      const [fabric] = await client`insert into fabrics (name) values ('Katun Rayon') returning id`;
      const [color] = await client`insert into fabric_colors (fabric_id, name) values (${fabric!.id}, 'Black') returning id`;
      const [product] = await client`
        insert into products (name, code, slug, fabric_id, closure, size_mode, base_price, is_published_on_storefront)
        values ('Haura Dress', 'HAURA', 'haura-dress', ${fabric!.id}, 'front_zip', 'sized', 269000, true) returning id`;
      for (const sku of ["HAURA-BLACK-M", "HAURA-BLACK-L"]) {
        await client`
          insert into product_variants (sku, product_id, fabric_id, fabric_color_id, closure, size)
          values (${sku}, ${product!.id}, ${fabric!.id}, ${color!.id}, 'front_zip', ${sku.endsWith("-M") ? "M" : "L"})`;
      }
      const [shopee] = await client`
        insert into orders (channel_id, order_no, channel_order_no, order_date, subtotal_amount, shipping_amount, total_amount)
        values ('shopee', 'ORD-202610-0001', 'SHP-1', now(), 269000, 0, 269000) returning id`;
      const [manualWeb] = await client`
        insert into orders (channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, total_amount, shipping_address)
        values ('web', 'ORD-202610-0002', now(), 'awaiting_payment', 269000, 10000, 279000, 'Jl. Lama 1') returning id`;
      await client`insert into order_items (order_id, sku, qty, unit_price, unit_cost) values (${shopee!.id}, 'HAURA-BLACK-M', 1, 269000, 120000)`;
      await client`insert into order_items (order_id, sku, qty, unit_price, unit_cost) values (${manualWeb!.id}, 'HAURA-BLACK-M', 1, 269000, 0)`;
      const [cart] = await client`insert into carts (token_hash) values ('hash-1') returning id`;
      await client`insert into cart_items (cart_id, sku, qty) values (${cart!.id}, 'HAURA-BLACK-M', 1)`;

      const [{ count: areasBefore }] = (await client`select count(*)::int as count from shipping_areas`) as unknown as [{ count: number }];
      expect(areasBefore).toBe(0);

      await migrate(drizzle(client), { migrationsFolder });

      // Nothing unpublished, no weight invented.
      const [haura] = await client`select is_published_on_storefront, shipping_weight_grams from products where id = ${product!.id}`;
      expect(haura).toEqual({ is_published_on_storefront: true, shipping_weight_grams: null });

      const existing = await client`
        select order_no, shipping_amount, total_amount, shipping_cost_amount, shipping_subsidy_amount, shipping_courier_code,
          shipping_service_code, shipping_courier_label, shipping_weight_grams, shipping_destination_id, shipping_quoted_at
        from orders order by order_no`;
      const noQuote = {
        shipping_cost_amount: null,
        shipping_subsidy_amount: null,
        shipping_courier_code: null,
        shipping_service_code: null,
        shipping_courier_label: null,
        shipping_weight_grams: null,
        shipping_destination_id: null,
        shipping_quoted_at: null,
      };
      expect(existing).toEqual([
        { order_no: "ORD-202610-0001", shipping_amount: "0", total_amount: "269000", ...noQuote },
        { order_no: "ORD-202610-0002", shipping_amount: "10000", total_amount: "279000", ...noQuote },
      ]);

      // The previous release's writes, naming only the columns it knows:
      // createProduct / updateProduct...
      const [created] = await client`
        insert into products (name, code, slug, fabric_id, closure, size_mode, base_price, description, is_active, highlights)
        values ('Gamis Basic', 'BASIC', 'gamis-basic', ${fabric!.id}, 'front_zip', 'sized', 259000, null, true, '{}') returning shipping_weight_grams`;
      expect(created!.shipping_weight_grams).toBeNull();
      await client`update products set name = 'Haura Dress Baru', base_price = 279000, is_active = true where id = ${product!.id}`;
      // ...updateProductStorefront (publish and unpublish, no weight involved)...
      await client`update products set is_published_on_storefront = false, storefront_description = '<p>Baru</p>' where slug = 'gamis-basic'`;
      await client`update products set is_published_on_storefront = true where slug = 'gamis-basic'`;
      // ...createOrder (manual entry, including on the `web` channel) with a free-typed ongkir...
      const [manual] = await client`
        insert into orders (channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, discount_amount, total_amount, notes)
        values ('web', 'ORD-202610-0003', now(), 'awaiting_payment', 259000, 15000, 0, 274000, 'via WA') returning id, shipping_cost_amount`;
      expect(manual!.shipping_cost_amount).toBeNull();
      // ...updateOrderItems' delete-and-reinsert, then a shipping_amount edit...
      await client`delete from order_items where order_id = ${manualWeb!.id}`;
      await client`insert into order_items (order_id, sku, qty, unit_price, unit_cost) values (${manualWeb!.id}, 'HAURA-BLACK-L', 2, 269000, 0)`;
      await client`update orders set subtotal_amount = 538000, shipping_amount = 12000, total_amount = 550000 where id = ${manualWeb!.id}`;
      // ...transitionOrderStatus (pay, ship with courier, cancel)...
      await client`update orders set status = 'to_ship' where id = ${manualWeb!.id}`;
      await client`update orders set status = 'shipped', shipped_at = now(), courier = 'JNE', tracking_number = 'JNE123' where id = ${manualWeb!.id}`;
      await client`update orders set status = 'cancelled', cancelled_at = now() where id = ${manual!.id}`;
      // ...and the session 5/6 cart writes.
      await client`
        insert into cart_items (cart_id, sku, qty) values (${cart!.id}, 'HAURA-BLACK-M', 2)
        on conflict (cart_id, sku) do update set qty = least(cart_items.qty + excluded.qty, 10)`;
      await client`update carts set last_activity_at = now() where id = ${cart!.id}`;
      const [{ qty }] = (await client`select qty from cart_items where cart_id = ${cart!.id}`) as unknown as [{ qty: number }];
      expect(qty).toBe(3);

      // shipping_areas: the four-column UNIQUE is gone, the Komerce id is the key, kode pos is
      // optional, and the new columns exist.
      const areaConstraints = await client`
        select conname from pg_constraint where conrelid = 'shipping_areas'::regclass and contype = 'u' order by conname`;
      expect(areaConstraints.map((row) => row.conname)).toEqual(["shipping_areas_komerce_destination_id_key"]);
      const [postalCode] = await client`
        select is_nullable from information_schema.columns where table_name = 'shipping_areas' and column_name = 'postal_code'`;
      expect(postalCode!.is_nullable).toBe("YES");
      await client`
        insert into shipping_areas (province, city, district, subdistrict, postal_code, search_text, label, komerce_destination_id)
        values ('Jawa Barat', 'Kota Bandung', 'Coblong', 'Dago', '40135', 'dago', 'Dago, Coblong', 'k-1'),
               ('Jawa Barat', 'Kota Bandung', 'Coblong', 'Lebak Siliwangi', '40135', 'lebak', 'Lebak Siliwangi, Coblong', 'k-2'),
               ('Papua', 'Kabupaten Contoh', 'Contoh', null, null, 'contoh', 'Contoh', 'k-3')`;

      // The set_updated_at trigger from 0030 still covers shipping_areas; the new cache table
      // has no updated_at (its fetched_at is set by the upsert).
      const triggers = await client`
        select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where t.tgname = 'set_updated_at' and c.relname in ('shipping_areas', 'shipping_rate_cache')`;
      expect(triggers.map((row) => row.relname)).toEqual(["shipping_areas"]);

      // Re-running the migrator applies nothing and changes nothing.
      const before = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      await migrate(drizzle(client), { migrationsFolder });
      const after = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(after).toEqual(before);
    } finally {
      await client.end();
      rmSync(upTo0030, { recursive: true, force: true });
    }
  });

  test("a checkout order without a quote (impossible before session 9) makes the whole migration roll back", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0030 = migrationsUpTo(30);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0030 });
      await client`
        insert into orders (channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, total_amount,
          payment_status, payment_expires_at, checkout_attempt_id, terms_accepted_at, promo_opt_in, placed_with_session)
        values ('web', 'ORD-202610-0009', now(), 'awaiting_payment', 259000, 0, 259000,
          'pending', now() + interval '1 hour', gen_random_uuid(), now(), false, false)`;

      await expect(migrate(drizzle(client), { migrationsFolder })).rejects.toThrow();

      const [{ count }] = (await client`
        select count(*)::int as count from information_schema.columns
        where table_name = 'products' and column_name = 'shipping_weight_grams'`) as unknown as [{ count: number }];
      expect(count).toBe(0);
      const [{ exists }] = (await client`select to_regclass('shipping_rate_cache') is not null as exists`) as unknown as [{ exists: boolean }];
      expect(exists).toBe(false);
    } finally {
      await client.end();
      rmSync(upTo0030, { recursive: true, force: true });
    }
  });
});
