import { defineConfig } from "vitest/config";

// Pure string rendering: no database, no network.
export default defineConfig({
  test: {
    environment: "node",
  },
});
