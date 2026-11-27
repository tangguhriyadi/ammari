import { beforeEach, vi } from "vitest";

// No test in this package may reach the network (docs/plans/tiktok-shop-integration.md T1: no
// TikTok API calls, the HTTP layer is mocked). Every client test injects its own fake `fetch`;
// the global one refuses everything, so a test that forgets to inject one fails loudly.
const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = async (input: URL | Request | string) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    throw new Error(`network access is blocked in tests: ${url.origin}`);
  };
  return () => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  };
});
