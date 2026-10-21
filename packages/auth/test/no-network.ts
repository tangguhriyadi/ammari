import { beforeEach, vi } from "vitest";

// No test in this package may reach the network (docs/plans/cart-checkout.md §13): each test starts
// with a fetch that refuses anything but loopback. A test that needs an answer stubs fetch itself
// (vi.spyOn(globalThis, "fetch")). Same guard as packages/commerce/test/setup.ts.
const realFetch = globalThis.fetch;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

beforeEach(() => {
  globalThis.fetch = async (input: URL | Request | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!LOOPBACK.has(url.hostname)) throw new Error(`network access is blocked in tests: ${url.origin}`);
    return realFetch(input, init);
  };
  return () => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  };
});
