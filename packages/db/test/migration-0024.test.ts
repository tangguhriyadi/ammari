import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0024 (docs/plans/suppliers-goods-receipt.md S3): applies on a fresh database, and on a
// database sitting at 0023 with legacy single-row purchases and stock in it — without touching
// that data, and while the PREVIOUS release's own writes and reads keep working against the new
// schema (CLAUDE.md expand/contract: rollback redeploys the old image against this schema).
//
// Runs against two disposable databases of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASES = ["ammari_migration_0024_fresh", "ammari_migration_0024_upgrade"] as const;

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

async function recreateDatabase(database: (typeof SCRATCH_DATABASES)[number]): Promise<void> {
  const admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
    await admin.unsafe(`CREATE DATABASE ${database}`);
  } finally {
    await admin.end();
  }
}

/** A copy of the migrations folder whose journal stops at `lastIdx` — drizzle's migrator applies
 * exactly what the journal lists. */
function migrationsUpTo(lastIdx: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ammari-migrations-"));
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

async function migrateTo(client: postgres.Sql, folder: string): Promise<void> {
  await migrate(drizzle(client), { migrationsFolder: folder });
}

afterAll(async () => {
  const admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  try {
    for (const database of SCRATCH_DATABASES) await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
  } finally {
    await admin.end();
  }
});

describe("migration 0024", () => {
  test("applies cleanly to a fresh database", async () => {
    await recreateDatabase("ammari_migration_0024_fresh");
    const client = postgres(urlFor("ammari_migration_0024_fresh"), { max: 1, onnotice: () => {} });
    try {
      await migrateTo(client, migrationsFolder);
      const tables = await client<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name in ('purchases', 'purchase_items', 'goods_receipts', 'goods_receipt_items')
        order by table_name`;
      expect(tables.map((row) => row.table_name)).toEqual(["goods_receipt_items", "goods_receipts", "purchase_items", "purchases"]);
      const [permission] = await client`select key from permissions where key = 'inventory.receive'`;
      expect(permission).toBeDefined();
      const triggers = await client<{ tgname: string }[]>`
        select tgname from pg_trigger where tgrelid = 'purchase_items'::regclass and not tgisinternal order by tgname`;
      expect(triggers.map((row) => row.tgname)).toEqual(["prevent_received_purchase_item_change", "prevent_received_purchase_item_delete"]);
    } finally {
      await client.end();
    }
  });

  test("upgrades a database at 0023 with legacy purchases and stock, and the previous release keeps working", async () => {
    await recreateDatabase("ammari_migration_0024_upgrade");
    const client = postgres(urlFor("ammari_migration_0024_upgrade"), { max: 1, onnotice: () => {} });
    const at0023 = migrationsUpTo(23);
    try {
      await migrateTo(client, at0023);

      // ---- Data as the previous release left it (raw SQL: the 0023 schema, no supplier_id). ----
      // Earlier migrations (0014) may already have created the system roles — upsert, don't assume.
      const upsertRole = (key: string, isSystem: boolean) =>
        client`insert into roles (key, name, is_system) values (${key}, ${key}, ${isSystem})
               on conflict (key) do update set name = excluded.name returning id`;
      const [superAdmin] = await upsertRole("super_admin", true);
      await upsertRole("owner", true);
      await upsertRole("packer", false);
      const [staff] = await client`insert into staff_users (name, email, role_id) values ('Owner', 'owner@example.test', ${superAdmin!.id}) returning id`;
      const [fabric] = await client`insert into fabrics (name) values ('Katun Lama') returning id`;
      const [accessory] = await client`insert into accessories (name) values ('Kancing Lama') returning id`;
      await client`
        insert into fabric_stock_movements (fabric_id, qty, value_amount, type, ref_type, purchased_at, supplier, created_by_staff_user_id)
        values (${fabric!.id}, 10.5, 1050000, 'purchase', 'manual', '2026-09-01', 'Toko Lama', ${staff!.id})`;
      await client`
        insert into fabric_stock_movements (fabric_id, qty, value_amount, type, ref_type, reason, created_by_staff_user_id)
        values (${fabric!.id}, -0.5, -50000, 'adjustment', 'manual', 'damaged', ${staff!.id})`;
      await client`
        insert into accessory_movements (accessory_id, qty, value_amount, type, ref_type, purchased_at, created_by_staff_user_id)
        values (${accessory!.id}, 100, 50000, 'purchase', 'manual', '2026-09-02', ${staff!.id})`;

      const balancesBefore = await client`
        select (select sum(qty)::text from fabric_stock_movements) as fabric_qty, (select sum(value_amount)::text from fabric_stock_movements) as fabric_value,
               (select sum(qty)::text from accessory_movements) as accessory_qty, (select sum(value_amount)::text from accessory_movements) as accessory_value`;

      // ---- Upgrade to head. ----
      await migrateTo(client, migrationsFolder);

      // Legacy data untouched, supplier_id simply NULL on it.
      const balancesAfter = await client`
        select (select sum(qty)::text from fabric_stock_movements) as fabric_qty, (select sum(value_amount)::text from fabric_stock_movements) as fabric_value,
               (select sum(qty)::text from accessory_movements) as accessory_qty, (select sum(value_amount)::text from accessory_movements) as accessory_value`;
      expect(balancesAfter).toEqual(balancesBefore);
      expect(balancesAfter[0]).toMatchObject({ fabric_qty: "10.00", fabric_value: "1000000", accessory_qty: "100", accessory_value: "50000" });
      const [withSupplier] = await client`
        select (select count(*)::int from fabric_stock_movements where supplier_id is not null) + (select count(*)::int from accessory_movements where supplier_id is not null) as n`;
      expect(withSupplier!.n).toBe(0);

      // inventory.receive granted to super_admin and owner (and nobody else) by the migration itself.
      const granted = await client<{ key: string }[]>`
        select r.key from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
        where p.key = 'inventory.receive' order by r.key`;
      expect(granted.map((row) => row.key)).toEqual(["owner", "super_admin"]);

      // The PREVIOUS release's purchase insert (no supplier_id column at all) still works.
      await client`
        insert into accessory_movements (accessory_id, qty, value_amount, type, ref_type, purchased_at, supplier, created_by_staff_user_id)
        values (${accessory!.id}, 5, 2500, 'purchase', 'manual', '2026-10-01', 'Toko Lama', ${staff!.id})`;

      // ...and so does its /purchases list, a UNION over both ledgers' 'purchase' rows.
      const previousReleaseList = await client`
        select * from (
          (select m.id, 'fabric' as "itemType", m.qty::numeric as qty from fabric_stock_movements m join fabrics f on f.id = m.fabric_id where m.type = 'purchase')
          union all
          (select m.id, 'accessory' as "itemType", m.qty::numeric as qty from accessory_movements m join accessories a on a.id = m.accessory_id where m.type = 'purchase')
        ) t order by t.id limit 20 offset 0`;
      expect(previousReleaseList).toHaveLength(3);

      // The widened CHECKs accept the new ref types, and still reject an unknown one.
      await client`
        insert into fabric_stock_movements (fabric_id, qty, value_amount, type, ref_type, ref_id, purchased_at, created_by_staff_user_id)
        values (${fabric!.id}, 1, 100, 'purchase', 'goods_receipt', 'some-receipt-item', '2026-10-02', ${staff!.id})`;
      await expect(
        client`
          insert into fabric_stock_movements (fabric_id, qty, value_amount, type, ref_type, ref_id, purchased_at, created_by_staff_user_id)
          values (${fabric!.id}, 1, 100, 'purchase', 'goods_receipt', 'some-receipt-item', '2026-10-02', ${staff!.id})`,
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        client`
          insert into fabric_stock_movements (fabric_id, qty, value_amount, type, ref_type, purchased_at, created_by_staff_user_id)
          values (${fabric!.id}, 1, 100, 'purchase', 'nonsense', '2026-10-02', ${staff!.id})`,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.end();
      rmSync(at0023, { recursive: true, force: true });
    }
  });
});
