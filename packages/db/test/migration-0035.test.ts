import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0035 (shipment tracking, docs/plans/cart-checkout.md §15 Phase K, K3): adds
// shipment_events, shipping_webhook_events and two nullable bookkeeping columns on shipments.
// Upgrades a database sitting at 0034 with a booked shipment, then checks the new rules (one event
// per shipment + time + status, allowed states and sources, payload or text), that existing rows are
// untouched, that the previous release's (K2) writes keep working, and that re-running the migrator
// is a no-op.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0035_upgrade";

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

describe("migration 0035 (shipment tracking)", () => {
  test("adds the tracking tables and columns, keeps rows, and leaves the previous release's writes working", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0034 = migrationsUpTo(34);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0034 });

      // State at 0034: a web order with a booked shipment (written with the columns that release knows).
      const [order] = await client`
        insert into orders (channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, discount_amount, total_amount)
        values ('web', 'ORD-202612-0001', now(), 'to_ship', 269000, 15000, 0, 284000) returning id`;
      const [shipment] = await client`
        insert into shipments (order_id, attempt, reference_id, provider, provider_order_id, status, courier, service, awb, booked_at)
        values (${order!.id}, 1, 'LOCAL-ORD-202612-0001-K1', 'biteship', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'pickup_requested', 'jne', 'reg', 'JNE0001', now())
        returning id`;

      await migrate(drizzle(client), { migrationsFolder });

      const [kept] = await client`select status, awb, refetch_requested_at, stale_flagged_at from shipments where id = ${shipment!.id}`;
      expect(kept).toEqual({ status: "pickup_requested", awb: "JNE0001", refetch_requested_at: null, stale_flagged_at: null });

      // One event per shipment, time and provider status; the same status at another time is another event.
      const at = "2026-12-02T03:00:00Z";
      await client`insert into shipment_events (shipment_id, occurred_at, provider_status, normalized_status, description, source)
        values (${shipment!.id}, ${at}, 'picked', 'picked_up', 'Paket dijemput', 'webhook')`;
      await expect(client`insert into shipment_events (shipment_id, occurred_at, provider_status, normalized_status, source)
        values (${shipment!.id}, ${at}, 'picked', 'picked_up', 'poll')`).rejects.toThrow(/shipment_events_shipment_id_occurred_at_provider_status_key/);
      await client`insert into shipment_events (shipment_id, occurred_at, provider_status, normalized_status, source)
        values (${shipment!.id}, ${at}, 'in_transit', 'in_transit', 'poll')`;
      const [deduped] = await client`insert into shipment_events (shipment_id, occurred_at, provider_status, normalized_status, source)
        values (${shipment!.id}, ${at}, 'picked', 'picked_up', 'poll') on conflict do nothing returning id`;
      expect(deduped).toBeUndefined();
      // An undocumented status is stored with no state; a booking state or an unknown source is not.
      await client`insert into shipment_events (shipment_id, occurred_at, provider_status, source) values (${shipment!.id}, ${at}, 'lost_in_space', 'poll')`;
      await expect(client`insert into shipment_events (shipment_id, occurred_at, provider_status, normalized_status, source)
        values (${shipment!.id}, now(), 'x', 'booking', 'poll')`).rejects.toThrow(/shipment_events_normalized_status_check/);
      await expect(client`insert into shipment_events (shipment_id, occurred_at, provider_status, source)
        values (${shipment!.id}, now(), 'x', 'cron')`).rejects.toThrow(/shipment_events_source_check/);
      const [described] = await client`select description, location from shipment_events where provider_status = 'in_transit'`;
      expect(described).toEqual({ description: "", location: null });

      // Webhook log rows: JSON payload, or raw text, never both; an empty body has neither.
      await client`insert into shipping_webhook_events (event, provider_order_id, shipment_id, payload, body_bytes)
        values ('order.status', 'aaaaaaaaaaaaaaaaaaaaaaaa', ${shipment!.id}, ${JSON.stringify({ order_id: "aaaaaaaaaaaaaaaaaaaaaaaa", status: "picked" })}::jsonb, 60)`;
      await client`insert into shipping_webhook_events (raw_text, body_bytes) values ('not json', 8)`;
      await client`insert into shipping_webhook_events (body_bytes) values (0)`;
      await expect(client`insert into shipping_webhook_events (payload, raw_text, body_bytes) values ('{}'::jsonb, 'x', 1)`).rejects.toThrow(
        /shipping_webhook_events_payload_or_text_check/,
      );
      await expect(client`insert into shipping_webhook_events (body_bytes) values (-1)`).rejects.toThrow(/shipping_webhook_events_body_bytes_check/);
      await expect(client`insert into shipping_webhook_events (shipment_id, body_bytes) values (gen_random_uuid(), 0)`).rejects.toThrow(
        /shipping_webhook_events_shipment_id_shipments_id_fk/,
      );

      // A shipment with tracking events cannot be deleted from under them.
      await expect(client`delete from shipments where id = ${shipment!.id}`).rejects.toThrow(/shipment_events_shipment_id_shipments_id_fk/);

      // The previous release's (K2) writes, which never name the new columns or tables.
      await client`update shipments set status = 'in_transit', provider_status = 'in_transit', picked_up_at = now(), last_error = null, updated_at = now() where id = ${shipment!.id}`;
      const [other] = await client`
        insert into orders (channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, discount_amount, total_amount)
        values ('web', 'ORD-202612-0002', now(), 'to_ship', 100000, 0, 0, 100000) returning id`;
      const [booking] = await client`
        insert into shipments (order_id, attempt, reference_id, provider, courier, service)
        values (${other!.id}, 1, 'LOCAL-ORD-202612-0002-K1', 'biteship', 'jne', 'reg') returning refetch_requested_at, stale_flagged_at`;
      expect(booking).toEqual({ refetch_requested_at: null, stale_flagged_at: null });

      // Re-running the migrator applies nothing and changes nothing.
      const before = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      await migrate(drizzle(client), { migrationsFolder });
      const after = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(after).toEqual(before);
    } finally {
      await client.end();
      rmSync(upTo0034, { recursive: true, force: true });
    }
  });
});
