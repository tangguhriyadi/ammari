import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Pure unit tests plus the runner's DB tests (test/runner.test.ts), which run inside rolled-back
// transactions on the shared `ammari_test` database. Same setup as packages/commerce: own .env
// first, then packages/db's (DATABASE_URL is read at import time by @ammari/db/test-utils), the
// shared migrate + seed global setup, and the serial test chain (turbo.json in this package).
for (const envFile of [".env", "../db/.env"]) {
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
    break;
  }
}

export default defineConfig({
  resolve: {
    alias: {
      // The real "server-only" module body throws outside Next's bundler (see packages/commerce).
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globalSetup: "@ammari/db/test-global-setup",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
