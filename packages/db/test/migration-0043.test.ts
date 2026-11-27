import { rmSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";
import { migrationsFolder, migrationsUpTo } from "./scratch-database";

// Migration 0043 (docs/plans/growth.md §6, owner answer A6): sales_goal.monthly_bill_categories,
// the "Pengingat biaya bulanan" categories. Upgrades a database sitting at 0042 whose goal row the
// owner already edited, then checks the edit survives with the reminder off ('{}'), that the
// previous release's goal save (an upsert naming only its own columns) still works, and that the
// new CHECKs refuse unknown and duplicate categories.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const SCRATCH_DATABASE = "ammari_migration_0043_upgrade";

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

afterAll(async () => {
  const admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`);
  } finally {
    await admin.end();
  }
});

describe("migration 0043 (monthly bills reminder categories)", () => {
  test("adds the column off by default, keeps the previous release's goal save working, and enforces the new rules", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0042 = migrationsUpTo(42);
    // Pinned to 0043: migration 0048 replaces constraints asserted here by name.
    const upTo0043 = migrationsUpTo(43);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0042 });
      await client`update sales_goal set revenue_target_amount = 1200000000 where id = 1`;

      await migrate(drizzle(client), { migrationsFolder: upTo0043 });

      const [row] = await client`select revenue_target_amount::text as target, monthly_bill_categories from sales_goal where id = 1`;
      expect(row).toEqual({ target: "1200000000", monthly_bill_categories: [] });

      // The previous release's saveSalesGoal: an upsert that knows nothing of the new column.
      await client`
        insert into sales_goal (id, revenue_target_amount, start_date) values (1, 900000000, '2026-11-01')
        on conflict (id) do update set revenue_target_amount = excluded.revenue_target_amount, start_date = excluded.start_date`;

      // Any of the fixed categories, in any order; never an unknown one or a duplicate.
      const [saved] = await client`update sales_goal set monthly_bill_categories = '{rent,salary,utilities}' returning monthly_bill_categories`;
      expect(saved!.monthly_bill_categories).toEqual(["rent", "salary", "utilities"]);
      await expect(client`update sales_goal set monthly_bill_categories = '{salary,gift}'`).rejects.toThrow(/sales_goal_monthly_bill_categories_allowed_check/);
      await expect(client`update sales_goal set monthly_bill_categories = '{salary,salary}'`).rejects.toThrow(/sales_goal_monthly_bill_categories_no_duplicates_check/);
      await expect(client`update sales_goal set monthly_bill_categories = null`).rejects.toThrow(/null value/);
      await client`update sales_goal set monthly_bill_categories = '{}'`;

      // Re-running the migrator applies nothing.
      const before = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      await migrate(drizzle(client), { migrationsFolder: upTo0043 });
      expect(await client`select count(*)::int as count from drizzle.__drizzle_migrations`).toEqual(before);
    } finally {
      await client.end();
      rmSync(upTo0042, { recursive: true, force: true });
      rmSync(upTo0043, { recursive: true, force: true });
    }
  });
});
