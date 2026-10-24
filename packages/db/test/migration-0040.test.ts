import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";
import { CHANNEL_FEE_COMPONENTS, IMPORT_BATCH_ORDER_ACTIONS, ORDER_ATTENTION_FLAGS } from "../src/schema/constants";

// Migration 0040 (docs/plans/marketplace-import.md §5, session 2): orders.channel_status and
// channel_synced_at, the order_channel_fees and import_batch_orders tables, three import_batches
// columns (file_sha256, summary, committed_at) and the marketplace_return_pending flag. Upgrades a
// database sitting at 0039 with a marketplace order carrying a flag and an import batch, then checks
// the new rules, that existing rows are untouched, that the previous release's writes keep working,
// and that re-running the migrator is a no-op.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0040_upgrade";
const SHA = "a".repeat(64);

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

describe("migration 0040 constants", () => {
  test("the fee vocabulary, batch-order actions and the new flag", () => {
    expect(CHANNEL_FEE_COMPONENTS).toEqual(["admin_fee", "service_fee", "platform_commission", "affiliate_commission", "seller_shipping_subsidy", "other"]);
    expect(IMPORT_BATCH_ORDER_ACTIONS).toEqual(["created", "updated"]);
    expect(ORDER_ATTENTION_FLAGS).toContain("marketplace_return_pending");
  });
});

describe("migration 0040 (marketplace import schema)", () => {
  test("adds the import columns and tables, keeps rows, and leaves the previous release's writes working", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0039 = migrationsUpTo(39);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0039 });

      // State at 0039: a staff user, a manual Shopee order with a flag, a second order, and a batch
      // written with the columns that release knows.
      const [role] = await client`select id from roles where key = 'owner'`;
      const [staff] = await client`
        insert into staff_users (name, email, role_id) values ('Pemilik Uji', 'pemilik-0040@example.test', ${role!.id}) returning id`;
      const [order] = await client`
        insert into orders (channel_id, order_no, channel_order_no, order_date, status, subtotal_amount, shipping_amount, discount_amount, total_amount, needs_attention)
        values ('shopee', 'ORD-202611-0001', '2611010ABCDEF', now(), 'to_ship', 259000, 0, 0, 259000, '{refund_received}') returning id`;
      const [other] = await client`
        insert into orders (channel_id, order_no, order_date, subtotal_amount, shipping_amount, discount_amount, total_amount)
        values ('whatsapp', 'ORD-202611-0002', now(), 100000, 0, 0, 100000) returning id`;
      const [oldBatch] = await client`
        insert into import_batches (channel_id, kind, filename, status, uploaded_by, row_count)
        values ('shopee', 'orders', 'lama.xlsx', 'previewed', ${staff!.id}, 3) returning id`;

      await migrate(drizzle(client), { migrationsFolder });

      // Existing rows untouched; the new columns are NULL.
      const [kept] = await client`select needs_attention, status, channel_status, channel_synced_at from orders where id = ${order!.id}`;
      expect(kept).toEqual({ needs_attention: ["refund_received"], status: "to_ship", channel_status: null, channel_synced_at: null });
      const [keptBatch] = await client`select status, row_count, file_sha256, summary, committed_at from import_batches where id = ${oldBatch!.id}`;
      expect(keptBatch).toEqual({ status: "previewed", row_count: 3, file_sha256: null, summary: null, committed_at: null });

      // ---- orders ----
      await client`update orders set needs_attention = needs_attention || '{marketplace_return_pending}'::text[] where id = ${order!.id}`;
      await expect(client`update orders set needs_attention = '{not_a_flag}' where id = ${order!.id}`).rejects.toThrow(/orders_needs_attention_allowed_check/);
      await expect(
        client`update orders set needs_attention = '{marketplace_return_pending,marketplace_return_pending}' where id = ${order!.id}`,
      ).rejects.toThrow(/orders_needs_attention_no_duplicates_check/);
      await client`update orders set channel_status = ${"x".repeat(64)}, channel_synced_at = now() where id = ${order!.id}`;
      await expect(client`update orders set channel_status = ${"x".repeat(65)} where id = ${order!.id}`).rejects.toThrow(/orders_channel_status_check/);
      await expect(client`update orders set channel_status = '' where id = ${order!.id}`).rejects.toThrow(/orders_channel_status_check/);

      // ---- import_batches ----
      const [batch] = await client`
        insert into import_batches (channel_id, kind, filename, status, uploaded_by, row_count, file_sha256, summary, committed_at)
        values ('shopee', 'orders', 'pesanan.xlsx', 'committed', ${staff!.id}, 12, ${SHA}, '{"created": 1}'::jsonb, now()) returning id`;
      await expect(client`
        insert into import_batches (channel_id, kind, filename, status, uploaded_by, file_sha256)
        values ('shopee', 'orders', 'x.xlsx', 'committed', ${staff!.id}, 'ABC')`).rejects.toThrow(/import_batches_file_sha256_check/);
      await expect(client`
        insert into import_batches (channel_id, kind, filename, status, uploaded_by, committed_at)
        values ('shopee', 'orders', 'x.xlsx', 'failed', ${staff!.id}, now())`).rejects.toThrow(/import_batches_committed_at_check/);

      // ---- order_channel_fees ----
      for (const component of CHANNEL_FEE_COMPONENTS) {
        await client`insert into order_channel_fees (order_id, component, amount, import_batch_id) values (${order!.id}, ${component}, 1000, ${batch!.id})`;
      }
      // One row per (order, component): re-import upserts in place.
      const [upserted] = await client`
        insert into order_channel_fees (order_id, component, amount) values (${order!.id}, 'admin_fee', 4500)
        on conflict (order_id, component) do update set amount = excluded.amount returning amount::int as amount, updated_at, created_at`;
      expect(upserted!.amount).toBe(4500);
      const [{ count: feeRows }] = (await client`select count(*)::int as count from order_channel_fees where order_id = ${order!.id}`) as unknown as [{ count: number }];
      expect(feeRows).toBe(CHANNEL_FEE_COMPONENTS.length);
      await expect(client`insert into order_channel_fees (order_id, component, amount) values (${order!.id}, 'admin_fee', 1)`).rejects.toThrow(
        /order_channel_fees_order_id_component_key/,
      );
      await expect(client`insert into order_channel_fees (order_id, component, amount) values (${other!.id}, 'ongkir', 1)`).rejects.toThrow(
        /order_channel_fees_component_check/,
      );
      await expect(client`insert into order_channel_fees (order_id, component, amount) values (${other!.id}, 'other', -1)`).rejects.toThrow(
        /order_channel_fees_amount_check/,
      );
      // updated_at is maintained by the shared trigger.
      const [touched] = await client`
        update order_channel_fees set amount = 5000, updated_at = '2000-01-01' where order_id = ${order!.id} and component = 'service_fee' returning updated_at`;
      expect(new Date(touched!.updated_at as string).getFullYear()).toBeGreaterThan(2000);

      // ---- import_batch_orders ----
      await client`insert into import_batch_orders (import_batch_id, order_id, action, changes) values (${batch!.id}, ${order!.id}, 'updated', '{"status": ["to_ship", "shipped"]}'::jsonb)`;
      const [defaulted] = await client`
        insert into import_batch_orders (import_batch_id, order_id, action) values (${batch!.id}, ${other!.id}, 'created') returning changes`;
      expect(defaulted!.changes).toEqual({});
      await expect(client`insert into import_batch_orders (import_batch_id, order_id, action) values (${batch!.id}, ${order!.id}, 'created')`).rejects.toThrow(
        /import_batch_orders_pkey/,
      );
      await expect(client`insert into import_batch_orders (import_batch_id, order_id, action) values (${oldBatch!.id}, ${order!.id}, 'deleted')`).rejects.toThrow(
        /import_batch_orders_action_check/,
      );

      // Neither an order nor a batch can be deleted from under its fee or history rows.
      await expect(client`delete from orders where id = ${other!.id}`).rejects.toThrow(/import_batch_orders_order_id_orders_id_fk/);
      await expect(client`delete from import_batches where id = ${batch!.id}`).rejects.toThrow(/_import_batch_id_import_batches_id_fk/);

      const indexes = await client`
        select indexname from pg_indexes where tablename in ('order_channel_fees', 'import_batch_orders') order by indexname`;
      expect(indexes.map((row) => row.indexname)).toEqual([
        "import_batch_orders_order_id_idx",
        "import_batch_orders_pkey",
        "order_channel_fees_import_batch_id_idx",
        "order_channel_fees_order_id_component_key",
        "order_channel_fees_pkey",
      ]);

      // ---- The previous release's writes, which never name any of the new columns or tables ----
      await client`update orders set needs_attention = array_remove(needs_attention, 'refund_received') where id = ${order!.id}`;
      await client`update orders set status = 'shipped', shipped_at = now(), updated_at = now() where id = ${order!.id}`;
      await client`
        insert into orders (channel_id, order_no, channel_order_no, order_date, subtotal_amount, shipping_amount, discount_amount, total_amount)
        values ('shopee', 'ORD-202611-0003', '2611010XYZ', now(), 249000, 0, 0, 249000)`;
      await client`
        insert into import_batches (channel_id, kind, filename, uploaded_by) values ('tiktok', 'orders', 'lama2.xlsx', ${staff!.id})`;

      // Re-running the migrator applies nothing.
      const before = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      await migrate(drizzle(client), { migrationsFolder });
      const after = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(after).toEqual(before);
    } finally {
      await client.end();
      rmSync(upTo0039, { recursive: true, force: true });
    }
  });
});
