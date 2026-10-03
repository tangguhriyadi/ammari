import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// RTL's auto-cleanup hooks into a GLOBAL `afterEach`, which this repo doesn't enable
// (vitest.config.ts has no `test.globals: true`, matching every other package's convention of
// explicit `import { ... } from "vitest"`) — so it's wired up explicitly here instead.
afterEach(() => {
  cleanup();
});
