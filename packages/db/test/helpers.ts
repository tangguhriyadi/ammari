import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

function testDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const url = new URL(raw);
  url.pathname = "/ammari_test";
  return url.toString();
}

const client = postgres(testDatabaseUrl(), { max: 5 });
export const testDb = drizzle(client);

export type TestTx = Parameters<Parameters<typeof testDb.transaction>[0]>[0];
/** Either the top-level test client or one of its transactions — mirrors apps/admin's own
 * `Database` union (`@/lib/db`). Fixture helpers in ./fixtures.ts accept this (not just
 * `TestTx`) so a test can call them with the real `testDb` directly when it needs genuine
 * cross-transaction concurrency (e.g. two real `testDb.transaction()` calls racing each other),
 * which `withRollback`'s single shared transaction can't exercise. */
export type TestDatabase = typeof testDb | TestTx;

class RollbackSignal extends Error {}

/** Temporarily disables ONE named trigger for a disposable test fixture's cleanup, then
 * re-enables it — ONLY for removing a row that a real append-only/immutability trigger
 * correctly rejects (e.g. deleting a posted batch, or a stock/accessory/fabric movement row
 * created solely for a "real commits, not withRollback" concurrency test). Never a way to work
 * around a real app code path — the trigger is correct production behavior; this exists purely
 * because disposable test data sometimes needs to be removed in ways production code never
 * does. `tableName`/`triggerName` are always hardcoded string literals from test code, never
 * user input — `sql.raw` is required here because Postgres identifiers in DDL can't be bound
 * parameters (same reasoning columns.ts's `checkIn` gives for its own use of `sql.raw`). */
export async function withTriggerDisabled(
  db: TestDatabase,
  tableName: string,
  triggerName: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  await db.execute(sql.raw(`ALTER TABLE "${tableName}" DISABLE TRIGGER "${triggerName}"`));
  try {
    await fn();
  } finally {
    await db.execute(sql.raw(`ALTER TABLE "${tableName}" ENABLE TRIGGER "${triggerName}"`));
  }
}

/** Runs `fn` inside a transaction that always rolls back, so writes from one test never leak
 * into another. Real constraints/triggers still fire — only the commit is skipped. */
export async function withRollback(fn: (tx: TestTx) => Promise<void>): Promise<void> {
  try {
    await testDb.transaction(async (tx) => {
      await fn(tx);
      throw new RollbackSignal();
    });
  } catch (error) {
    if (!(error instanceof RollbackSignal)) throw error;
  }
}
