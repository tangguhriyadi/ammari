import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

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

class RollbackSignal extends Error {}

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
