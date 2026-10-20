import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, test } from "vitest";

// Migration 0029: announcement bar + homepage meta columns on store_settings, and the Hero's
// published OG image key on storefront_homepage_sections. Upgrades a database sitting at 0028
// that already has owner-entered settings and a published Hero, and checks the previous
// release's own writes keep working against the new schema (expand/contract).
//
// Runs against a disposable database of its own, never `ammari` or `ammari_test`.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const SCRATCH_DATABASE = "ammari_migration_0029_upgrade";

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

describe("migration 0029 (announcement bar, homepage meta, Hero OG key)", () => {
  test("keeps existing settings, turns the bar on with the default text, and leaves the previous release's writes working", async () => {
    await recreateDatabase();
    const client = postgres(urlFor(SCRATCH_DATABASE), { max: 1, onnotice: () => {} });
    const upTo0028 = migrationsUpTo(28);
    try {
      await migrate(drizzle(client), { migrationsFolder: upTo0028 });
      await client`update store_settings set whatsapp_number = '6281234567890', support_email = 'halo@ammari.id' where id = 1`;
      await client`update storefront_homepage_sections set published_is_visible = true, published_content = '{"headline":"Lama"}'::jsonb where key = 'hero'`;

      await migrate(drizzle(client), { migrationsFolder });

      const [settings] = await client`select * from store_settings where id = 1`;
      expect(settings).toMatchObject({
        whatsapp_number: "6281234567890",
        support_email: "halo@ammari.id",
        announcement_bar_enabled: true,
        announcement_bar_text: "Gratis Ongkir Ke Seluruh Indonesia",
        homepage_meta_title: null,
        homepage_meta_description: null,
      });
      const [hero] = await client`select published_og_image_key, published_content from storefront_homepage_sections where key = 'hero'`;
      expect(hero).toMatchObject({ published_og_image_key: null, published_content: { headline: "Lama" } });

      // The previous release's store settings save names only the 4 columns it knows.
      await client`update store_settings set whatsapp_number = null, support_email = null, business_address = 'Jl. Contoh No. 1', return_policy_summary = null where id = 1`;
      // ...and its homepage publish copies draft -> published without the new column.
      await client`update storefront_homepage_sections set published_content = draft_content, published_is_visible = draft_is_visible, published_at = now() where key = 'hero'`;
      const [after] = await client`select business_address, announcement_bar_enabled from store_settings where id = 1`;
      expect(after).toMatchObject({ business_address: "Jl. Contoh No. 1", announcement_bar_enabled: true });

      await expect(client`update store_settings set announcement_bar_text = ${"a".repeat(41)} where id = 1`).rejects.toThrow(
        /store_settings_announcement_bar_text_length_check/,
      );
    } finally {
      await client.end();
      rmSync(upTo0028, { recursive: true, force: true });
    }
  });
});
