import { beforeEach, vi } from "vitest";

// No test in this package may reach the network (docs/plans/cart-checkout.md §13: nothing in CI
// or e2e reaches Biteship or Midtrans). Each test starts with a fetch that refuses anything but
// loopback; a test that needs an answer stubs fetch itself (vi.spyOn(globalThis, "fetch")) or
// injects one into the client.
const realFetch = globalThis.fetch;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// The only exceptions: the opt-in contract tests (src/shipping/biteship.contract.test.ts,
// src/shipping/biteship-orders.contract.test.ts (also needs BITESHIP_ORDER_CONTRACT_TEST=1),
// src/payments/midtrans.contract.test.ts), run by hand with BITESHIP_CONTRACT_TEST=1 /
// MIDTRANS_CONTRACT_TEST=1 and test or sandbox keys; never in CI or a normal `pnpm test`. The
// Midtrans exception names the Sandbox hosts only.
const allowedHosts = new Set<string>([
  ...(process.env.BITESHIP_CONTRACT_TEST === "1" ? ["api.biteship.com"] : []),
  ...(process.env.MIDTRANS_CONTRACT_TEST === "1" ? ["app.sandbox.midtrans.com", "api.sandbox.midtrans.com"] : []),
]);

beforeEach(() => {
  globalThis.fetch = async (input: URL | Request | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!LOOPBACK.has(url.hostname) && !allowedHosts.has(url.hostname)) throw new Error(`network access is blocked in tests: ${url.origin}`);
    return realFetch(input, init);
  };
  return () => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  };
});
