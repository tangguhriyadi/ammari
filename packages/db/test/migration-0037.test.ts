import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0037 (product types, docs/plans/product-types.md): adds product_types with its one
// reference row (DRESS / "Gamis") and products.product_type_code NOT NULL DEFAULT 'DRESS'.
// Upgrades a database sitting at 0036 with a product, then checks that the existing product
// becomes DRESS, that the previous release's writes (which never name the new column) keep
// working, that the new constraints hold, and that re-running the migrator is a no-op.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0037_upgrade";

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

describe("migration 0037 (product types)", () => {
  test("backfills DRESS, keeps the previous release's writes working, and enforces the new rules", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0036 = migrationsUpTo(36);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0036 });

      // State at 0036: one product.
      const [fabric] = await client`insert into fabrics (name) values ('Katun Rayon') returning id`;
      const [product] = await client`
        insert into products (name, code, slug, fabric_id, closure, size_mode, base_price)
        values ('Gamis Lama', 'LAMA', 'gamis-lama', ${fabric!.id}, 'front_zip', 'sized', 350000) returning id`;

      await migrate(drizzle(client), { migrationsFolder });

      // The reference row exists, and the existing product became DRESS.
      const types = await client`select code, name, is_active, sort_order from product_types`;
      expect(types).toEqual([{ code: "DRESS", name: "Gamis", is_active: true, sort_order: 0 }]);
      const [kept] = await client`select product_type_code from products where id = ${product!.id}`;
      expect(kept).toEqual({ product_type_code: "DRESS" });

      // The previous release's writes, which never name the new column: a product edit and a new
      // product (which gets the default).
      await client`update products set base_price = 360000, updated_at = now() where id = ${product!.id}`;
      const [created] = await client`
        insert into products (name, code, slug, fabric_id, closure, size_mode, base_price)
        values ('Gamis Baru', 'BARU', 'gamis-baru', ${fabric!.id}, 'front_zip', 'all_size', 299000)
        returning product_type_code`;
      expect(created).toEqual({ product_type_code: "DRESS" });

      // The column can't be NULL or point at a type that doesn't exist.
      await expect(client`update products set product_type_code = null where id = ${product!.id}`).rejects.toThrow(/null value/);
      await expect(client`update products set product_type_code = 'NOPE' where id = ${product!.id}`).rejects.toThrow(
        /products_product_type_code_product_types_code_fk/,
      );

      // Code format, name rules, immutable code, and no delete while in use.
      await expect(client`insert into product_types (code, name) values ('khimar', 'Khimar')`).rejects.toThrow(/product_types_code_check/);
      await expect(client`insert into product_types (code, name) values ('1SET', 'Set')`).rejects.toThrow(/product_types_code_check/);
      await expect(client`insert into product_types (code, name) values ('KHIMAR', '  ')`).rejects.toThrow(/product_types_name_check/);
      await expect(client`insert into product_types (code, name) values ('GAMIS2', 'gamis')`).rejects.toThrow(/product_types_name_unique/);
      await client`insert into product_types (code, name, sort_order) values ('KHIMAR', 'Khimar', 1)`;
      await expect(client`update product_types set code = 'KHIMAR_X' where code = 'KHIMAR'`).rejects.toThrow(/immutable/);
      await expect(client`update product_types set code = 'DRESS_X' where code = 'DRESS'`).rejects.toThrow(/immutable/);
      // Never deleted, used or not (the BEFORE DELETE trigger fires before the FK check).
      await expect(client`delete from product_types where code = 'DRESS'`).rejects.toThrow(/never deleted/);
      await expect(client`delete from product_types where code = 'KHIMAR'`).rejects.toThrow(/never deleted/);
      // Renaming and deactivating are ordinary updates, and updated_at moves.
      const [renamed] = await client`
        update product_types set name = 'Gamis Syari', is_active = false, updated_at = '2000-01-01' where code = 'DRESS'
        returning name, is_active, updated_at`;
      expect(renamed!.name).toBe("Gamis Syari");
      expect(renamed!.is_active).toBe(false);
      expect(new Date(renamed!.updated_at as string).getFullYear()).toBeGreaterThan(2000);

      // Re-running the migrator applies nothing and changes nothing (the rename survives).
      const before = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      await migrate(drizzle(client), { migrationsFolder });
      const after = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(after).toEqual(before);
      const [stillRenamed] = await client`select name from product_types where code = 'DRESS'`;
      expect(stillRenamed).toEqual({ name: "Gamis Syari" });
    } finally {
      await client.end();
      rmSync(upTo0036, { recursive: true, force: true });
    }
  });
});
