import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0028: data-only backfill of the default photo alt text ("<product>" for a general
// photo, "<product> warna <color>" for a color photo) into every EMPTY alt text. Upgrades a
// database sitting at 0027 with blank, whitespace-only and hand-typed alt texts, and is idempotent.
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0028_upgrade";

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

describe("migration 0028 (default photo alt text backfill)", () => {
  test("fills only empty alt texts with the default, keeps hand-typed ones, and is idempotent", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0027 = migrationsUpTo(27);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0027 });

      const [fabric] = await client`insert into fabrics (name) values ('Katun') returning id`;
      const [color] = await client`insert into fabric_colors (fabric_id, name) values (${fabric!.id}, 'Taupe') returning id`;
      const [product] = await client`
        insert into products (name, code, slug, fabric_id, closure, size_mode, base_price)
        values ('Haura Dress', 'HRD01', 'haura-dress', ${fabric!.id}, 'front_zip', 'sized', 259000) returning id`;
      const insertImage = async (key: string, fabricColorId: string | null, altText: string | null) => {
        const [row] = await client`
          insert into product_images (product_id, fabric_id, fabric_color_id, storage_key, alt_text, width, height, sort_order)
          values (${product!.id}, ${fabric!.id}, ${fabricColorId}, ${key}, ${altText}, 800, 1200, 0) returning id`;
        return row!.id as string;
      };
      const blankColor = await insertImage("k/1", color!.id, null);
      const whitespaceGeneral = await insertImage("k/2", null, " \t\n ");
      const handTyped = await insertImage("k/3", color!.id, "Tampak samping");

      await migrate(drizzle(client), { migrationsFolder });

      const altOf = async (id: string) => (await client`select alt_text from product_images where id = ${id}`)[0]!.alt_text;
      expect(await altOf(blankColor)).toBe("Haura Dress warna Taupe");
      expect(await altOf(whitespaceGeneral)).toBe("Haura Dress");
      expect(await altOf(handTyped)).toBe("Tampak samping");

      // Idempotent: re-running the migration's own statement changes nothing.
      const sqlText = readFileSync(path.join(migrationsFolder, "0028_product_image_default_alt_text.sql"), "utf8");
      const result = await client.unsafe(sqlText);
      expect(result.count).toBe(0);
    } finally {
      await client.end();
      rmSync(upTo0027, { recursive: true, force: true });
    }
  });
});
