import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// Next.js hot reload re-evaluates this module on every change in dev; without
// caching the client on globalThis, each reload would open a fresh connection
// pool and leak connections against the local Postgres instance.
const globalForDb = globalThis as unknown as {
  postgresClient?: ReturnType<typeof postgres>;
};

const client =
  process.env.NODE_ENV === "production"
    ? postgres(DATABASE_URL, { max: 5 })
    : (globalForDb.postgresClient ??= postgres(DATABASE_URL, { max: 5 }));

export const db = drizzle(client);
