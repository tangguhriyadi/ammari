import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// No database: this package only signs, verifies, parses and encrypts (docs/plans/
// tiktok-shop-integration.md §2, T1), so it runs fully in parallel with the DB-backed suites.
export default defineConfig({
  resolve: {
    alias: {
      // Same stand-in packages/commerce uses: the real "server-only" module throws unless Next's
      // bundler intercepts it, which never happens under plain Vitest.
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Refuses every fetch, so no test can reach TikTok, even by accident.
    setupFiles: ["./test/setup.ts"],
    testTimeout: 20_000,
  },
});
