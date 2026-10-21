import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// RTL's auto-cleanup hooks into a GLOBAL `afterEach`, which this repo doesn't enable
// (vitest.config.ts has no `test.globals: true`, matching every other package's convention of
// explicit `import { ... } from "vitest"`) — so it's wired up explicitly here instead. Same
// setup as apps/admin's own test/setup.ts.
afterEach(() => {
  cleanup();
});

// No test in this app may reach the network (docs/plans/cart-checkout.md §13: nothing in CI or e2e
// reaches Midtrans or Biteship). Same guard as packages/commerce/test/setup.ts: every test starts
// with a fetch that refuses anything but loopback; a test that needs an answer stubs fetch itself.
const realFetch = globalThis.fetch;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

beforeEach(() => {
  globalThis.fetch = async (input: URL | Request | string, init?: RequestInit) => {
    // Relative URLs (component tests under jsdom) resolve against the test page, which is local.
    const url = new URL(input instanceof Request ? input.url : String(input), globalThis.location?.href ?? "http://localhost/");
    if (!LOOPBACK.has(url.hostname)) throw new Error(`network access is blocked in tests: ${url.origin}`);
    return realFetch(input, init);
  };
  return () => {
    globalThis.fetch = realFetch;
  };
});
