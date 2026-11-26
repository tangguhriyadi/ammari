import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// A disposable database of its own, always named ammari_scratch_* (never `ammari` or
// `ammari_test`), for tests that must commit for real: migration upgrades, deferred constraint
// triggers that only fire at COMMIT, closed periods, and concurrent transactions.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
export const migrationsFolder = path.join(packageRoot, "drizzle");

function localUrl(database: string): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const url = new URL(raw);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`Refusing to run scratch-database tests against non-local host "${url.hostname}".`);
  }
  url.pathname = `/${database}`;
  return url.toString();
}

/** Scratch databases are dropped with FORCE, so only names under this prefix are accepted: a
 * developer's own `ammari_backup` (or `ammari`, `ammari_test`, `ammari_e2e`) can never match. */
const SCRATCH_PREFIX = "ammari_scratch_";

export function scratchUrl(database: string): string {
  if (!database.startsWith(SCRATCH_PREFIX) || !/^[a-z0-9_]+$/.test(database) || database.length <= SCRATCH_PREFIX.length) {
    throw new Error(`Refusing to use "${database}" as a scratch database: the name must start with "${SCRATCH_PREFIX}".`);
  }
  return localUrl(database);
}

export async function recreateScratchDatabase(database: string): Promise<void> {
  scratchUrl(database);
  const admin = postgres(localUrl("postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${database}`);
  } finally {
    await admin.end();
  }
}

export async function dropScratchDatabase(database: string): Promise<void> {
  scratchUrl(database);
  const admin = postgres(localUrl("postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** A copy of the migrations folder whose journal stops at `lastIdx`, so a test can pin itself to
 * one migration and a later one can't change what it asserts. */
export function migrationsUpTo(lastIdx: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ammari-migrations-"));
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}
