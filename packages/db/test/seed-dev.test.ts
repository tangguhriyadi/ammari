import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, test } from "vitest";
import { seedDev } from "../src/seed-dev";
import { testDb } from "./helpers";

describe("seedDev", () => {
  test("refuses to run against a db connection that isn't actually local", async () => {
    // postgres() is lazy — constructing it reads `.options` without opening a connection, so
    // this never attempts to reach "prod-db.example.com". The guard must check the `db` it was
    // actually given, not an ambient env var that could disagree with it.
    const fakeProdClient = postgres("postgresql://user:pass@prod-db.example.com:5432/ammari");
    try {
      const fakeProdDb = drizzle(fakeProdClient);
      await expect(seedDev(fakeProdDb)).rejects.toThrow(/non-local host/);
    } finally {
      await fakeProdClient.end({ timeout: 0 });
    }
  });

  test("runs against localhost without throwing, and is idempotent", async () => {
    await seedDev(testDb);
    await expect(seedDev(testDb)).resolves.not.toThrow();
  });
});
