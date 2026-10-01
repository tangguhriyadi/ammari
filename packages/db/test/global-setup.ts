import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { seed } from "../src/seed";

// Resolved relative to this file, not `process.cwd()` — a second package (e.g. @ammari/auth)
// reuses this module via the `@ammari/db/test-global-setup` export while running with its own
// package directory as cwd, so a cwd-relative path would silently look in the wrong place.
const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const envPath = path.join(packageRoot, ".env");
const migrationsFolder = path.join(packageRoot, "drizzle");

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

function requireDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  return raw;
}

/** Refuses to run unless the derived test target is unambiguously local and named exactly
 * `ammari_test` — tests must never be able to touch the Sumopod dev database. */
function assertSafeTestTarget(url: URL) {
  const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const dbName = url.pathname.replace(/^\//, "");
  if (!isLocalHost || dbName !== "ammari_test") {
    throw new Error(
      `Refusing to run tests: derived test database target is "${url.hostname}${url.pathname}". ` +
        `Tests only ever run against host localhost/127.0.0.1, database "ammari_test". ` +
        `Check DATABASE_URL.`,
    );
  }
}

export default async function setup() {
  const rawUrl = requireDatabaseUrl();
  const adminUrl = new URL(rawUrl);
  const testUrl = new URL(rawUrl);
  testUrl.pathname = "/ammari_test";

  assertSafeTestTarget(testUrl);

  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    const [row] = await admin<{ exists: boolean }[]>`
      select exists(select 1 from pg_database where datname = 'ammari_test') as exists
    `;
    if (!row?.exists) {
      await admin.unsafe(`CREATE DATABASE ammari_test`);
    }
  } finally {
    await admin.end();
  }

  const testClient = postgres(testUrl.toString(), { max: 5 });
  try {
    const testDb = drizzle(testClient);
    await migrate(testDb, { migrationsFolder });
    await seed(testDb);
  } finally {
    await testClient.end();
  }
}
