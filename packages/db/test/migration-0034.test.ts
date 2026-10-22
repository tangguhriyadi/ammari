import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0034 (shipments, docs/plans/cart-checkout.md §15 Phase K, K2): adds the shipments table
// (one row per booking attempt) and widens orders.needs_attention with shipping_cost_over_quote and
// tracking_number_mismatch. Upgrades a database sitting at 0033 with a paid web order carrying a
// flag, then checks the new rules (one live attempt per order, unique references and provider ids,
// state consistency), that existing rows are untouched, that the previous release's (K1) writes keep
// working, and that re-running the migrator is a no-op.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0034_upgrade";

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

describe("migration 0034 (shipments)", () => {
  test("adds shipments and the two flags, keeps rows, and leaves the previous release's writes working", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0033 = migrationsUpTo(33);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0033 });

      // State at 0033: a manual web order already carrying a flag (written with the columns that
      // release knows).
      const [order] = await client`
        insert into orders (channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, discount_amount, total_amount, needs_attention)
        values ('web', 'ORD-202612-0001', now(), 'to_ship', 269000, 15000, 0, 284000, '{refund_received}') returning id`;
      const [other] = await client`
        insert into orders (channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, discount_amount, total_amount)
        values ('web', 'ORD-202612-0002', now(), 'to_ship', 100000, 0, 0, 100000) returning id`;

      await migrate(drizzle(client), { migrationsFolder });

      const [kept] = await client`select needs_attention, status from orders where id = ${order!.id}`;
      expect(kept).toEqual({ needs_attention: ["refund_received"], status: "to_ship" });

      // The two new flags are accepted; anything else still is not, nor a duplicate.
      await client`update orders set needs_attention = needs_attention || '{shipping_cost_over_quote,tracking_number_mismatch}'::text[] where id = ${order!.id}`;
      await expect(client`update orders set needs_attention = '{not_a_flag}' where id = ${order!.id}`).rejects.toThrow(/orders_needs_attention_allowed_check/);
      await expect(client`update orders set needs_attention = '{tracking_number_mismatch,tracking_number_mismatch}' where id = ${order!.id}`).rejects.toThrow(
        /orders_needs_attention_no_duplicates_check/,
      );

      // Attempt 1 is reserved ("booking", no provider id yet); a second live attempt is refused.
      const [first] = await client`
        insert into shipments (order_id, attempt, reference_id, provider, courier, service)
        values (${order!.id}, 1, 'LOCAL-ORD-202612-0001-K1', 'biteship', 'jne', 'reg') returning id, status`;
      expect(first!.status).toBe("booking");
      await expect(client`
        insert into shipments (order_id, attempt, reference_id, provider, courier, service)
        values (${order!.id}, 2, 'LOCAL-ORD-202612-0001-K2', 'biteship', 'jne', 'reg')`).rejects.toThrow(/shipments_live_order_id_key/);

      // A booked state needs the provider's order id.
      await expect(client`update shipments set status = 'pickup_requested' where id = ${first!.id}`).rejects.toThrow(/shipments_provider_order_id_check/);
      await client`update shipments set status = 'pickup_requested', provider_order_id = 'aaaaaaaaaaaaaaaaaaaaaaaa', awb = 'JNE0001', cost_amount = 20000, booked_at = now() where id = ${first!.id}`;

      // Cancelled needs its time, then the next attempt may go live.
      await expect(client`update shipments set status = 'cancelled' where id = ${first!.id}`).rejects.toThrow(/shipments_cancelled_at_check/);
      await client`update shipments set status = 'cancelled', cancelled_at = now() where id = ${first!.id}`;
      const [second] = await client`
        insert into shipments (order_id, attempt, reference_id, provider, courier, service)
        values (${order!.id}, 2, 'LOCAL-ORD-202612-0001-K2', 'biteship', 'jne', 'reg') returning id`;

      // A refused attempt is "failed" with its time and never a provider order.
      await expect(client`update shipments set status = 'failed' where id = ${second!.id}`).rejects.toThrow(/shipments_failed_consistency_check/);
      await expect(client`update shipments set failed_at = now() where id = ${second!.id}`).rejects.toThrow(/shipments_failed_consistency_check/);
      await expect(
        client`update shipments set status = 'failed', failed_at = now(), provider_order_id = 'bbbbbbbbbbbbbbbbbbbbbbbb' where id = ${second!.id}`,
      ).rejects.toThrow(/shipments_failed_unbooked_check/);
      await client`update shipments set status = 'failed', failed_at = now(), last_error = 'refused:40002039' where id = ${second!.id}`;

      // References and provider ids are unique across orders; attempts are 1 to 99 and unique per order.
      await expect(client`
        insert into shipments (order_id, attempt, reference_id, provider, courier, service)
        values (${other!.id}, 1, 'LOCAL-ORD-202612-0001-K1', 'biteship', 'jne', 'reg')`).rejects.toThrow(/shipments_reference_id_key/);
      await expect(client`
        insert into shipments (order_id, attempt, reference_id, provider, provider_order_id, status, courier, service)
        values (${other!.id}, 1, 'LOCAL-ORD-202612-0002-K1', 'biteship', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'pickup_requested', 'jne', 'reg')`).rejects.toThrow(
        /shipments_provider_order_id_key/,
      );
      await expect(client`
        insert into shipments (order_id, attempt, reference_id, provider, courier, service)
        values (${other!.id}, 100, 'LOCAL-ORD-202612-0002-K100', 'biteship', 'jne', 'reg')`).rejects.toThrow(/shipments_attempt_check/);
      await expect(client`
        insert into shipments (order_id, attempt, reference_id, provider, courier, service)
        values (${order!.id}, 2, 'LOCAL-ORD-202612-0001-K2B', 'biteship', 'jne', 'reg')`).rejects.toThrow(/shipments_order_id_attempt_key/);
      await expect(client`
        insert into shipments (order_id, attempt, reference_id, provider, provider_order_id, courier, service, status)
        values (${other!.id}, 1, 'LOCAL-ORD-202612-0002-K1', 'biteship', 'cccccccccccccccccccccccc', 'jne', 'reg', 'shipped')`).rejects.toThrow(/shipments_status_check/);
      await expect(client`
        insert into shipments (order_id, attempt, reference_id, provider, courier, service)
        values (${other!.id}, 1, 'LOCAL-ORD-202612-0002-K1', 'komerce', 'jne', 'reg')`).rejects.toThrow(/shipments_provider_check/);
      await expect(client`
        insert into shipments (order_id, attempt, reference_id, provider, courier, service, cost_amount)
        values (${other!.id}, 1, 'LOCAL-ORD-202612-0002-K1', 'biteship', 'jne', 'reg', -1)`).rejects.toThrow(/shipments_cost_amount_check/);

      // An order with shipments cannot be deleted from under them.
      await expect(client`delete from orders where id = ${order!.id}`).rejects.toThrow(/shipments_order_id_orders_id_fk/);

      // The previous release's (K1) writes, which never name shipments or the new flags.
      await client`update orders set needs_attention = array_remove(needs_attention, 'refund_received') where id = ${order!.id}`;
      await client`update orders set status = 'shipped', courier = 'JNE', tracking_number = 'JNE0001', shipped_at = now() where id = ${order!.id}`;
      await client`update orders set needs_attention = '{delivery_problem}' where id = ${other!.id}`;

      // Re-running the migrator applies nothing and changes nothing.
      const before = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      await migrate(drizzle(client), { migrationsFolder });
      const after = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(after).toEqual(before);
    } finally {
      await client.end();
      rmSync(upTo0033, { recursive: true, force: true });
    }
  });
});
