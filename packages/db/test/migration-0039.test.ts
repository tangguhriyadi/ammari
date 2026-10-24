import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0039 (docs/plans/dashboard-overview.md §2.1, §7): adds the single-row sales_goal table
// with its one reference row (Rp 1.000.000.000 from 2026-11-01) and orders_order_date_idx.
// Upgrades a database sitting at 0038 with an order, then checks the row and index exist, that the
// previous release's order writes keep working, that the new constraints hold, and that re-running
// the migrator is a no-op that keeps an owner edit.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0039_upgrade";

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

describe("migration 0039 (sales goal, order date index)", () => {
  test("ships the goal row and the index, keeps the previous release's order writes working, and enforces the new rules", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0038 = migrationsUpTo(38);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0038 });

      // State at 0038: one order (channels ship in an earlier migration).
      const [order] = await client`
        insert into orders (channel_id, order_no, channel_order_no, order_date, subtotal_amount, shipping_amount, discount_amount, total_amount)
        values ('shopee', 'ORD-202611-0001', 'SHP-1', '2026-11-02T03:00:00Z', 259000, 10000, 0, 269000) returning id`;

      await migrate(drizzle(client), { migrationsFolder });

      const goal = await client`select id, revenue_target_amount::text as target, start_date::text as start_date from sales_goal`;
      expect(goal).toEqual([{ id: 1, target: "1000000000", start_date: "2026-11-01" }]);
      const [index] = await client`select indexdef from pg_indexes where indexname = 'orders_order_date_idx'`;
      expect(index?.indexdef).toMatch(/ON public\.orders USING btree \(order_date\)/);

      // The previous release's order writes, which know nothing of either: an edit and a new order.
      await client`update orders set status = 'shipped', shipped_at = now(), updated_at = now() where id = ${order!.id}`;
      await client`
        insert into orders (channel_id, order_no, order_date, subtotal_amount, shipping_amount, discount_amount, total_amount)
        values ('whatsapp', 'ORD-202611-0002', now(), 249000, 0, 0, 249000)`;

      // One row only, and a positive target.
      await expect(client`insert into sales_goal (id) values (2)`).rejects.toThrow(/sales_goal_id_check/);
      await expect(client`insert into sales_goal (id) values (1)`).rejects.toThrow(/sales_goal_pkey/);
      await expect(client`update sales_goal set revenue_target_amount = 0`).rejects.toThrow(/sales_goal_revenue_target_amount_check/);
      // The start date may be cleared (not configured), and updated_at moves.
      const [edited] = await client`
        update sales_goal set revenue_target_amount = 1200000000, start_date = null, updated_at = '2000-01-01'
        returning revenue_target_amount::text as target, start_date, updated_at`;
      expect(edited!.target).toBe("1200000000");
      expect(edited!.start_date).toBeNull();
      expect(new Date(edited!.updated_at as string).getFullYear()).toBeGreaterThan(2000);

      // Re-running the migrator applies nothing and never resets the owner's edit.
      const before = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      await migrate(drizzle(client), { migrationsFolder });
      const after = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(after).toEqual(before);
      const [stillEdited] = await client`select revenue_target_amount::text as target from sales_goal`;
      expect(stillEdited).toEqual({ target: "1200000000" });
    } finally {
      await client.end();
      rmSync(upTo0038, { recursive: true, force: true });
    }
  });
});
