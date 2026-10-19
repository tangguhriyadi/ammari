import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0025 (docs/plans/suppliers-goods-receipt.md S4): applies on a fresh database, and on
// a database sitting at 0024 with posted and draft production batches — backfilling the posted
// ones to 'received' without touching their stock, idempotently, while the PREVIOUS release's own
// writes keep working against the new schema (CLAUDE.md expand/contract: rollback redeploys the
// old image against this schema).
//
// Runs against two disposable databases of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASES = ["ammari_migration_0025_fresh", "ammari_migration_0025_upgrade"] as const;

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

/** The backfill statement exactly as migration 0025 ships it, re-run to prove it is idempotent. */
function backfillStatement(): string {
  const sqlText = readFileSync(path.join(migrationsFolder, "0025_production_receipts.sql"), "utf8");
  const match = sqlText.match(/UPDATE "production_batches"[\s\S]*?;/);
  if (!match) throw new Error("backfill statement not found in migration 0025");
  return match[0];
}

afterAll(async () => {
  const admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  try {
    for (const database of SCRATCH_DATABASES) await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
  } finally {
    await admin.end();
  }
});

describe("migration 0025", () => {
  test("applies cleanly to a fresh database", async () => {
    await recreateDatabase("ammari_migration_0025_fresh");
    const client = postgres(urlFor("ammari_migration_0025_fresh"), { max: 1, onnotice: () => {} });
    try {
      await migrateTo(client, migrationsFolder);
      const columns = await client<{ column_name: string; column_default: string | null; is_nullable: string }[]>`
        select column_name, column_default, is_nullable from information_schema.columns
        where table_name = 'production_batches' and column_name in ('receipt_status', 'closed_at', 'closed_by_staff_user_id', 'close_reason')
        order by column_name`;
      expect(columns.map((row) => [row.column_name, row.is_nullable])).toEqual([
        ["close_reason", "YES"],
        ["closed_at", "YES"],
        ["closed_by_staff_user_id", "YES"],
        ["receipt_status", "NO"],
      ]);
      expect(columns.find((row) => row.column_name === "receipt_status")?.column_default).toContain("'pending'");
      const [index] = await client<{ indexdef: string }[]>`select indexdef from pg_indexes where indexname = 'stock_movements_type_ref_unique_idx'`;
      expect(index?.indexdef).toContain("goods_receipt_item");
      expect(index?.indexdef).toContain("production_batch_item");
      expect(index?.indexdef).toContain("order_item");
    } finally {
      await client.end();
    }
  });

  test("upgrades a database at 0024 with posted and draft batches: posted backfilled to received, stock untouched, previous release keeps working", async () => {
    await recreateDatabase("ammari_migration_0025_upgrade");
    const client = postgres(urlFor("ammari_migration_0025_upgrade"), { max: 1, onnotice: () => {} });
    const at0024 = migrationsUpTo(24);
    try {
      await migrateTo(client, at0024);

      // ---- Data as the previous release left it (raw SQL against the 0024 schema). ----
      const [role] = await client`
        insert into roles (key, name, is_system) values ('super_admin', 'super_admin', true)
        on conflict (key) do update set name = excluded.name returning id`;
      const [staff] = await client`insert into staff_users (name, email, role_id) values ('Owner', 'owner@example.test', ${role!.id}) returning id`;
      const [fabric] = await client`insert into fabrics (name) values ('Katun Lama') returning id`;
      const [color] = await client`insert into fabric_colors (fabric_id, name) values (${fabric!.id}, 'Hitam') returning id`;
      const [product] = await client`
        insert into products (name, code, slug, fabric_id, closure, size_mode, base_price)
        values ('Gamis Lama', 'LAMA01', 'gamis-lama', ${fabric!.id}, 'front_zip', 'sized', 259000) returning id`;
      const [variant] = await client`
        insert into product_variants (sku, product_id, fabric_id, fabric_color_id, closure, size)
        values ('LAMA01-HTM-M', ${product!.id}, ${fabric!.id}, ${color!.id}, 'front_zip', 'M') returning sku`;

      /** A batch with one line, posted the way the previous release posts: lines inserted while a
       * draft, then status -> posted, then one at-posting 'production' stock row per line. */
      const insertBatch = async (batchNo: string, post: boolean) => {
        const [batch] = await client`
          insert into production_batches (fabric_id, batch_no, produced_at, fabric_yards)
          values (${fabric!.id}, ${batchNo}, '2026-09-01', 5) returning id`;
        const [line] = await client`
          insert into production_batch_items (production_batch_id, fabric_id, sku, qty, unit_cost_amount)
          values (${batch!.id}, ${fabric!.id}, ${variant!.sku}, 4, 0) returning id`;
        if (post) {
          await client`update production_batch_items set unit_cost_amount = 120000 where id = ${line!.id}`;
          await client`update production_batches set status = 'posted', posted_at = now(), posted_by_staff_user_id = ${staff!.id}, fabric_cost_amount = 480000 where id = ${batch!.id}`;
          await client`
            insert into stock_movements (sku, qty, value_amount, type, ref_type, ref_id, created_by_staff_user_id)
            values (${variant!.sku}, 4, 480000, 'production', 'production_batch_item', ${line!.id}, ${staff!.id})`;
        }
        return { batchId: batch!.id as string, lineId: line!.id as string };
      };
      const posted = await insertBatch("PRD-202609-001", true);
      const draft = await insertBatch("PRD-202609-002", false);

      const stockBefore = await client`select sum(qty)::int as qty, sum(value_amount)::text as value from stock_movements`;

      // ---- Upgrade to head. ----
      await migrateTo(client, migrationsFolder);

      const statuses = await client<{ id: string; status: string; receipt_status: string }[]>`
        select id, status, receipt_status from production_batches order by batch_no`;
      expect(statuses).toEqual([
        { id: posted.batchId, status: "posted", receipt_status: "received" },
        { id: draft.batchId, status: "draft", receipt_status: "pending" },
      ]);
      // Stock untouched: the posted batch's output was added at posting and is counted once.
      expect(await client`select sum(qty)::int as qty, sum(value_amount)::text as value from stock_movements`).toEqual(stockBefore);
      expect(stockBefore[0]).toMatchObject({ qty: 4, value: "480000" });

      // The backfill is idempotent: re-running it changes nothing.
      const rerun = await client.unsafe(backfillStatement());
      expect(rerun.count).toBe(0);

      // The PREVIOUS release keeps working: it posts the draft exactly as before (status only,
      // receipt_status left at its default) and writes its at-posting stock row.
      await client`update production_batch_items set unit_cost_amount = 120000 where id = ${draft.lineId}`;
      await client`update production_batches set status = 'posted', posted_at = now(), posted_by_staff_user_id = ${staff!.id} where id = ${draft.batchId}`;
      await client`
        insert into stock_movements (sku, qty, value_amount, type, ref_type, ref_id, created_by_staff_user_id)
        values (${variant!.sku}, 4, 480000, 'production', 'production_batch_item', ${draft.lineId}, ${staff!.id})`;
      const [afterOldPost] = await client`select status, receipt_status from production_batches where id = ${draft.batchId}`;
      expect(afterOldPost).toMatchObject({ status: "posted", receipt_status: "pending" });
      // ...and the freeze trigger still guards `status` exactly as before.
      await expect(client`update production_batches set status = 'draft' where id = ${posted.batchId}`).rejects.toMatchObject({ code: "23514" });

      // New CHECKs: a draft is always pending; closed needs its stamp; the pair stays together.
      const [freshDraft] = await client`
        insert into production_batches (fabric_id, batch_no, produced_at) values (${fabric!.id}, 'PRD-202609-003', '2026-09-02') returning id`;
      await expect(client`update production_batches set receipt_status = 'received' where id = ${freshDraft!.id}`).rejects.toMatchObject({ code: "23514" });
      await expect(client`update production_batches set receipt_status = 'closed' where id = ${posted.batchId}`).rejects.toMatchObject({ code: "23514" });
      await expect(client`update production_batches set closed_at = now() where id = ${posted.batchId}`).rejects.toMatchObject({ code: "23514" });
      await expect(client`update production_batches set receipt_status = 'nonsense' where id = ${posted.batchId}`).rejects.toMatchObject({ code: "23514" });
      // A closed posted batch with its stamp is fine, and closing does not trip the freeze trigger.
      await client`update production_batches set receipt_status = 'closed', closed_at = now(), closed_by_staff_user_id = ${staff!.id}, close_reason = 'x' where id = ${posted.batchId}`;

      // The widened unique index now also covers receipt-backed rows.
      await client`
        insert into stock_movements (sku, qty, value_amount, type, ref_type, ref_id)
        values (${variant!.sku}, 1, 120000, 'production', 'goods_receipt_item', 'some-receipt-item')`;
      await expect(
        client`
          insert into stock_movements (sku, qty, value_amount, type, ref_type, ref_id)
          values (${variant!.sku}, 1, 120000, 'production', 'goods_receipt_item', 'some-receipt-item')`,
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await client.end();
      rmSync(at0024, { recursive: true, force: true });
    }
  });
});
