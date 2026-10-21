import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Own .env first (same as packages/auth), then packages/db's — this package has no settings of
// its own beyond DATABASE_URL, which @ammari/db/test-utils needs at import time in every worker.
for (const envFile of [".env", "../db/.env"]) {
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
    break;
  }
}

export default defineConfig({
  resolve: {
    alias: {
      // Same stand-in apps/admin's vitest.config.mts uses: the real "server-only" module body
      // throws unless Next's bundler intercepts it, which never happens under plain Vitest.
      // Production code (bundled by Next through transpilePackages) still gets the real one.
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Migrates + seeds `ammari_test` (same as packages/auth and apps/admin).
    globalSetup: "@ammari/db/test-global-setup",
    // Refuses every non-local fetch, so no test can reach a real provider (Biteship, Midtrans),
    // even by accident (plan §13).
    setupFiles: ["./test/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
