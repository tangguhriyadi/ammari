import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors tsconfig.json's "@/*" path mapping — Vitest doesn't read tsconfig paths itself.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The real package's module body unconditionally throws unless Next's own bundler
      // intercepts it (see test/stubs/server-only.ts) — only test code is affected; a real
      // `next build`/`next dev` never resolves this alias.
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/e2e/**"],
    // Migrates + seeds `ammari_test` before the suite runs (same pattern packages/auth and
    // apps/admin use) — a future DB-backed test pays for this once; a pure-function test (like
    // the consent gate today) pays the cost too, same accepted trade-off apps/admin's own
    // vitest.config.mts documents.
    globalSetup: "@ammari/db/test-global-setup",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
