import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0030 (checkout core): upgrades a database sitting at 0029 that already has orders
// (a marketplace order and a staff-entered `web` order) and checks that the previous release's
// own writes keep working against the new schema (expand/contract), that the hand-added
// triggers exist, and that re-running the migrator is a no-op.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0030_upgrade";

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

describe("migration 0030 (checkout core)", () => {
  test("keeps existing orders, applies defaults, and leaves the previous release's writes working", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0029 = migrationsUpTo(29);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0029 });

      // State at 0029, written with the columns the previous release knows.
      const [fabric] = await client`insert into fabrics (name) values ('Katun Rayon') returning id`;
      const [color] = await client`insert into fabric_colors (fabric_id, name) values (${fabric!.id}, 'Black') returning id`;
      const [product] = await client`
        insert into products (name, code, slug, fabric_id, closure, size_mode, base_price)
        values ('Gamis Basic', 'BASIC', 'gamis-basic', ${fabric!.id}, 'front_zip', 'sized', 259000) returning id`;
      for (const sku of ["BASIC-BLACK-M", "BASIC-BLACK-L"]) {
        await client`
          insert into product_variants (sku, product_id, fabric_id, fabric_color_id, closure, size)
          values (${sku}, ${product!.id}, ${fabric!.id}, ${color!.id}, 'front_zip', ${sku.endsWith("-M") ? "M" : "L"})`;
      }
      const [shopee] = await client`
        insert into orders (channel_id, order_no, channel_order_no, order_date, subtotal_amount, shipping_amount, total_amount)
        values ('shopee', 'ORD-202610-0001', 'SHP-1', now(), 259000, 0, 259000) returning id`;
      const [manualWeb] = await client`
        insert into orders (channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, total_amount, shipping_address)
        values ('web', 'ORD-202610-0002', now(), 'awaiting_payment', 259000, 10000, 269000, 'Jl. Lama 1') returning id`;
      await client`insert into order_items (order_id, sku, qty, unit_price, unit_cost) values (${shopee!.id}, 'BASIC-BLACK-M', 1, 259000, 120000)`;
      await client`insert into order_items (order_id, sku, qty, unit_price, unit_cost) values (${manualWeb!.id}, 'BASIC-BLACK-M', 1, 259000, 0)`;

      await migrate(drizzle(client), { migrationsFolder });

      const existing = await client`
        select order_no, payment_status, needs_attention, cancel_reason, placed_with_session, checkout_attempt_id, shipping_address
        from orders order by order_no`;
      expect(existing).toEqual([
        expect.objectContaining({ order_no: "ORD-202610-0001", payment_status: null, needs_attention: [], cancel_reason: null }),
        expect.objectContaining({
          order_no: "ORD-202610-0002",
          payment_status: null,
          needs_attention: [],
          placed_with_session: null,
          checkout_attempt_id: null,
          shipping_address: "Jl. Lama 1",
        }),
      ]);

      // The previous release's writes, naming only the columns it knows:
      // createOrder (manual entry, including on the `web` channel)...
      const [created] = await client`
        insert into orders (channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, discount_amount, total_amount, notes)
        values ('web', 'ORD-202610-0003', now(), 'awaiting_payment', 259000, 0, 0, 259000, 'via WA') returning id, needs_attention`;
      expect(created!.needs_attention).toEqual([]);
      // ...updateOrderItems' delete-and-reinsert while awaiting_payment...
      await client`delete from order_items where order_id = ${manualWeb!.id}`;
      await client`insert into order_items (order_id, sku, qty, unit_price, unit_cost) values (${manualWeb!.id}, 'BASIC-BLACK-L', 2, 259000, 0)`;
      await client`update orders set subtotal_amount = 518000, total_amount = 528000 where id = ${manualWeb!.id}`;
      // ...transitionOrderStatus (pay, ship with courier, cancel), with no cancel_reason...
      await client`update orders set status = 'to_ship' where id = ${manualWeb!.id}`;
      await client`update orders set status = 'shipped', shipped_at = now(), courier = 'JNE', tracking_number = 'JNE123' where id = ${manualWeb!.id}`;
      await client`update orders set status = 'cancelled', cancelled_at = now() where id = ${created!.id}`;
      // ...and the customer link a voucher claim writes.
      const [customer] = await client`insert into customers (name, email) values ('Siti', 'siti@example.test') returning id`;
      await client`update orders set customer_id = ${customer!.id} where id = ${shopee!.id}`;

      const triggers = await client`
        select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where t.tgname = 'set_updated_at' and c.relname in ('carts', 'customer_addresses', 'payments', 'shipping_areas', 'order_notifications')
        order by c.relname`;
      expect(triggers.map((row) => row.relname)).toEqual([
        "carts",
        "customer_addresses",
        "order_notifications",
        "payments",
        "shipping_areas",
      ]);

      const [{ count: shippingAreas }] = (await client`select count(*)::int as count from shipping_areas`) as unknown as [{ count: number }];
      expect(shippingAreas).toBe(0);

      // Re-running the migrator applies nothing and changes nothing.
      const before = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      await migrate(drizzle(client), { migrationsFolder });
      const after = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(after).toEqual(before);
    } finally {
      await client.end();
      rmSync(upTo0029, { recursive: true, force: true });
    }
  });
});
