import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

export default defineConfig({
  test: {
    globalSetup: "@ammari/db/test-global-setup",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
