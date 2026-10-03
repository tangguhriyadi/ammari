import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { seed } from "../src/seed";

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");

const E2E_DATABASE_NAME = "ammari_e2e";

/** Derives the e2e target database URL from a base `DATABASE_URL` (same host/port/credentials,
 * database name swapped to `ammari_e2e`) and refuses anything that isn't unambiguously local —
 * the same guard test/global-setup.ts applies to `ammari_test`, so e2e runs (Playwright's own
 * global setup AND the `next dev` server it spawns) can never reach the real Sumopod dev
 * database. */
export function deriveE2eDatabaseUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  url.pathname = `/${E2E_DATABASE_NAME}`;
  const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!isLocalHost) {
    throw new Error(
      `Refusing to use e2e database target "${url.hostname}${url.pathname}" — e2e only ever runs against ` +
        `host localhost/127.0.0.1, database "${E2E_DATABASE_NAME}". Check DATABASE_URL.`,
    );
  }
  return url;
}

/** Creates (if needed), migrates, TRUNCATEs, and baseline-seeds `ammari_e2e` — a full reset on
 * every call, not just a one-time setup. Kept as its own database, separate from both the
 * owner's real `ammari` dev database and `ammari_test`, so a Playwright run's fixtures (`Contoh
 * Gamis ... E2E ...` products, `e2e_products_no_finance` role, etc.) never show up in the
 * owner's own product list, and never accumulate across runs either. Returns the e2e database
 * URL; call sites still need to point their own `DATABASE_URL` at it (the admin's
 * `e2e/global-setup.ts` does this for both the Playwright process itself and the `next dev`
 * server it spawns, via `playwright.config.ts`'s `webServer.env`). */
export async function ensureE2eDatabase(rawUrl: string): Promise<string> {
  const e2eUrl = deriveE2eDatabaseUrl(rawUrl);

  const admin = postgres(rawUrl, { max: 1 });
  try {
    const [row] = await admin<{ exists: boolean }[]>`
      select exists(select 1 from pg_database where datname = ${E2E_DATABASE_NAME}) as exists
    `;
    if (!row?.exists) {
      await admin.unsafe(`CREATE DATABASE ${E2E_DATABASE_NAME}`);
    }
  } finally {
    await admin.end();
  }

  const e2eClient = postgres(e2eUrl.toString(), { max: 5 });
  try {
    const e2eDb = drizzle(e2eClient);
    await migrate(e2eDb, { migrationsFolder });

    // Reset to a clean slate on EVERY run, not just once at creation — otherwise every
    // Playwright run leaves its uniquely-timestamped fixtures behind (products, fabrics, staff
    // users, ...) and ammari_e2e grows without bound across repeated local runs, until something
    // that assumes a short, single-page list (e.g. the product form's fabric <select>, limited
    // to PAGE_SIZE) silently stops showing a just-created fixture. Real data never lands in this
    // database in the first place (see deriveE2eDatabaseUrl's guard above), so truncating
    // unconditionally is safe — drizzle-kit's own migration-tracking table lives in a separate
    // "drizzle" schema, so this only ever touches this app's own tables.
    const tables = await e2eClient<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'public'
    `;
    if (tables.length > 0) {
      const tableList = tables.map((row) => `"${row.tablename}"`).join(", ");
      await e2eClient.unsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    }

    await seed(e2eDb);
  } finally {
    await e2eClient.end();
  }

  return e2eUrl.toString();
}
