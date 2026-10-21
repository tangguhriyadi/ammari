import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0033 (customer login links, docs/plans/cart-checkout.md §9.3, session 14): adds
// customer_login_links and customers.contact_offer_resolved_at. Upgrades a database sitting at 0032
// with a customer and an order, then checks the new table's rules (one live link per customer,
// hash-only tokens, one way to end), that existing rows are untouched, that the previous release's
// (session 13) writes keep working, and that re-running the migrator is a no-op.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0033_upgrade";

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

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

describe("migration 0033 (customer login links)", () => {
  test("adds the login link table and the offer column, keeps rows, and leaves the previous release's writes working", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0032 = migrationsUpTo(32);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0032 });

      // State at 0032, written with the columns that release knows.
      const [customer] = await client`
        insert into customers (email, name, phone, promo_consent_at) values ('pembeli@example.com', 'Pembeli', '+6281234567890', now()) returning id`;
      const [order] = await client`
        insert into orders (channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, discount_amount, total_amount, customer_id)
        values ('web', 'ORD-202610-0001', now(), 'to_ship', 269000, 15000, 0, 284000, ${customer!.id}) returning id`;

      await migrate(drizzle(client), { migrationsFolder });

      // Existing customers get no answer recorded; nothing else changed.
      const [kept] = await client`select email, phone, contact_offer_resolved_at from customers where id = ${customer!.id}`;
      expect(kept).toEqual({ email: "pembeli@example.com", phone: "+6281234567890", contact_offer_resolved_at: null });

      // A live link, then a second live link for the same customer is refused by the index.
      await client`
        insert into customer_login_links (customer_id, email, token_hash, order_id, expires_at)
        values (${customer!.id}, 'Pembeli@Example.com', ${HASH_A}, ${order!.id}, now() + interval '24 hours')`;
      await expect(client`
        insert into customer_login_links (customer_id, email, token_hash, expires_at)
        values (${customer!.id}, 'pembeli@example.com', ${HASH_B}, now() + interval '24 hours')`).rejects.toThrow(/customer_login_links_live_customer_id_key/);
      // Superseding the live one frees the slot.
      await client`update customer_login_links set superseded_at = now() where token_hash = ${HASH_A}`;
      await client`
        insert into customer_login_links (customer_id, email, token_hash, expires_at)
        values (${customer!.id}, 'pembeli@example.com', ${HASH_B}, now() + interval '24 hours')`;

      // Only a sha256 hex digest is accepted as the token, and each hash once.
      await expect(client`
        insert into customer_login_links (customer_id, email, token_hash, expires_at)
        values (${customer!.id}, 'pembeli@example.com', 'raw-token', now() + interval '24 hours')`).rejects.toThrow(/customer_login_links_token_hash_format_check/);
      await expect(client`
        insert into customer_login_links (customer_id, email, token_hash, superseded_at, expires_at)
        values (${customer!.id}, 'pembeli@example.com', ${HASH_A}, now(), now() + interval '24 hours')`).rejects.toThrow(/customer_login_links_token_hash_key/);

      // A link ends one way, and the IP is recorded only with a consume.
      await expect(client`update customer_login_links set consumed_at = now() where token_hash = ${HASH_A}`).rejects.toThrow(
        /customer_login_links_single_end_check/,
      );
      await expect(client`update customer_login_links set consumed_ip = '203.0.113.7' where token_hash = ${HASH_B}`).rejects.toThrow(
        /customer_login_links_consumed_ip_check/,
      );
      await client`update customer_login_links set consumed_at = now(), consumed_ip = '203.0.113.7' where token_hash = ${HASH_B}`;
      await expect(client`
        insert into customer_login_links (customer_id, email, token_hash, expires_at, created_at)
        values (${customer!.id}, 'pembeli@example.com', ${HASH_C}, now() - interval '1 hour', now())`).rejects.toThrow(
        /customer_login_links_expires_after_created_check/,
      );

      // Customers and orders a link points at cannot be deleted from under it.
      await expect(client`delete from orders where id = ${order!.id}`).rejects.toThrow(/customer_login_links_order_id_orders_id_fk/);

      // The previous release's (session 13) writes, which never name the new column.
      await client`insert into customers (email, name) values ('tamu@example.com', 'Tamu')`;
      await client`update customers set phone = '+6281298765432', promo_consent_at = now() where email = 'tamu@example.com'`;
      await client`
        insert into order_notifications (order_id, kind) values (${order!.id}, 'paid')
        on conflict (order_id, kind) do nothing`;
      await client`
        insert into order_access_tokens (order_id, token_hash, expires_at) values (${order!.id}, ${HASH_C}, now() + interval '120 days')`;

      // Re-running the migrator applies nothing and changes nothing.
      const before = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      await migrate(drizzle(client), { migrationsFolder });
      const after = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(after).toEqual(before);
    } finally {
      await client.end();
      rmSync(upTo0032, { recursive: true, force: true });
    }
  });
});
