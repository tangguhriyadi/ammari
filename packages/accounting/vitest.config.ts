import { defineConfig } from "vitest/config";

// Pure unit tests only (no database): the ledger's database rules are tested in packages/db
// (accounting-ledger.test.ts, migration-0049.test.ts). A DB-backed suite added here later must
// join the serial test chain (see packages/commerce/turbo.json) and the shared global setup.
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20_000,
  },
});
