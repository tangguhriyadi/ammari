import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default stays "node" — only component tests need jsdom, opted in per-file via a
    // `// @vitest-environment jsdom` pragma (see test/Switch.test.tsx), so the existing
    // pure-logic tests (format.test.ts, pagination.test.ts) keep their faster environment.
    environment: "node",
    setupFiles: ["./test/setup.ts"],
  },
});
