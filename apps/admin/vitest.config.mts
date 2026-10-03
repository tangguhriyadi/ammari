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
    // Migrates + seeds `ammari_test` before the suite runs (same pattern packages/auth uses) —
    // product server-action integration tests exercise a real DB; pure-function tests (nav
    // filter, e2e-login-gate, sku/slug/money/batas-hpp) don't need it but pay the cost too,
    // consistent with how packages/auth's whole suite already does this.
    globalSetup: "@ammari/db/test-global-setup",
    // Component tests opt into jsdom per-file via a `// @vitest-environment jsdom` pragma
    // (mirrors packages/ui's convention) — the default above stays "node".
    setupFiles: ["./test/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
