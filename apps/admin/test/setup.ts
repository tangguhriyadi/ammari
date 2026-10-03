import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// RTL's auto-cleanup hooks into a GLOBAL `afterEach`, which this repo doesn't enable
// (vitest.config.mts has no `test.globals: true`, matching packages/ui's convention of explicit
// `import { ... } from "vitest"`) — so it's wired up explicitly here instead.
afterEach(() => {
  cleanup();
});
