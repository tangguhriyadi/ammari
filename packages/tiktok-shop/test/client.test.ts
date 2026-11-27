import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_REQUEST_TIMEOUT_MS, TikTokApiError, createTikTokClient, type FetchLike, type TikTokClientOptions } from "../src/client";
import { Secret } from "../src/secret";
import { signRequest } from "../src/sign";
import { seeded } from "./random";

// Every response here comes from an in-memory fake; no request leaves the process
// (test/setup.ts also blocks the global fetch).

const APP_KEY = "dummyappkey";
const APP_SECRET = "dummyappsecret0123456789";
const ACCESS_TOKEN = "ROW_dummy_access_token_ABC123";
const REFRESHED_TOKEN = "ROW_dummy_access_token_REFRESHED";
const START = Date.UTC(2026, 10, 27, 3, 0, 0);

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | "network-error";

interface Call {
  url: URL;
  init: RequestInit;
}

function harness(replies: Reply[], extra: Partial<TikTokClientOptions> = {}) {
  let clock = START;
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: new URL(input), init });
    const reply = replies.shift();
    if (reply === undefined) throw new Error("test: no more replies");
    if (reply === "network-error") throw new TypeError(`fetch failed: ${input}`);
    const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? ok({}));
    return new Response(body, { status: reply.status ?? 200, headers: reply.headers });
  };
  const client = createTikTokClient({
    appKey: new Secret(APP_KEY),
    appSecret: new Secret(APP_SECRET),
    baseUrl: "https://tiktok.test",
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: seeded(1),
    ...extra,
  });
  return { client, calls, sleeps, advance: (ms: number) => (clock += ms), now: () => clock };
}

function ok(data: unknown) {
  return { code: 0, message: "Success", request_id: "req-ok", data };
}
const RATE_LIMITED_ENVELOPE = { code: 36009002, message: "rate limit", request_id: "req-rl" };

const shopsSchema = z.object({ shops: z.array(z.object({ id: z.string(), cipher: z.string() })) });
const shops = ok({ shops: [{ id: "7000000000000000001", cipher: "ROW_dummycipher1" }] });

function get(client: ReturnType<typeof harness>["client"], extra: Record<string, unknown> = {}) {
  return client.request({ method: "GET", path: "/authorization/202309/shops", schema: shopsSchema, accessToken: new Secret(ACCESS_TOKEN), ...extra });
}

async function rejection(promise: Promise<unknown>): Promise<TikTokApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TikTokApiError);
    return error as TikTokApiError;
  }
  throw new Error("expected a TikTokApiError");
}

describe("request building and signing", () => {
  test("GET: app_key, 10-digit timestamp, sign over the sorted query, token header (not query)", async () => {
    const h = harness([{ body: shops }]);
    const data = await get(h.client);
    expect(data.shops[0]!.cipher).toBe("ROW_dummycipher1");
    const { url, init } = h.calls[0]!;
    expect(url.origin + url.pathname).toBe("https://tiktok.test/authorization/202309/shops");
    expect(url.searchParams.get("app_key")).toBe(APP_KEY);
    expect(url.searchParams.get("timestamp")).toBe(String(Math.floor(START / 1000)));
    expect(url.searchParams.get("timestamp")).toMatch(/^[0-9]{10}$/);
    expect(url.searchParams.has("access_token")).toBe(false);
    const query = Object.fromEntries([...url.searchParams].filter(([key]) => key !== "sign"));
    expect(url.searchParams.get("sign")).toBe(signRequest({ appSecret: APP_SECRET, path: url.pathname, query }));
    const headers = init.headers as Record<string, string>;
    expect(headers["x-tts-access-token"]).toBe(ACCESS_TOKEN);
    expect(headers["content-type"]).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.method).toBe("GET");
  });

  test("POST: the body is serialized once and that exact string is signed and sent", async () => {
    const h = harness([{ body: ok({ orders: [] }) }]);
    const body = { update_time_ge: 1700000000, update_time_lt: 1700021600, sort_order: "ASC" };
    await h.client.request({
      method: "POST",
      path: "/order/202309/orders/search",
      query: { page_size: 100, sort_field: "update_time" },
      body,
      shopCipher: "ROW_dummycipher1",
      accessToken: new Secret(ACCESS_TOKEN),
      schema: z.object({ orders: z.array(z.unknown()) }),
    });
    const { url, init } = h.calls[0]!;
    expect(init.body).toBe(JSON.stringify(body));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(url.searchParams.get("shop_cipher")).toBe("ROW_dummycipher1");
    const query = Object.fromEntries([...url.searchParams].filter(([key]) => key !== "sign"));
    expect(url.searchParams.get("sign")).toBe(signRequest({ appSecret: APP_SECRET, path: url.pathname, query, body: init.body as string }));
    expect(url.searchParams.get("sign")).not.toBe(signRequest({ appSecret: APP_SECRET, path: url.pathname, query }));
  });

  test("page_token with + / = is URL-encoded in the URL and signed raw", async () => {
    const h = harness([{ body: ok({ orders: [] }) }]);
    const pageToken = "aGVsbG8+d29ybGQ/Zm9v+YmFy/==";
    await h.client.request({ method: "POST", path: "/order/202309/orders/search", query: { page_token: pageToken }, body: {}, schema: z.unknown() });
    const { url } = h.calls[0]!;
    expect(url.search).toContain(`page_token=${encodeURIComponent(pageToken)}`);
    expect(url.search).toContain("page_token=aGVsbG8%2Bd29ybGQ%2FZm9v%2BYmFy%2F%3D%3D");
    expect(url.search).not.toContain("page_token=aGVsbG8+");
    expect(url.searchParams.get("page_token")).toBe(pageToken);
    const query = Object.fromEntries([...url.searchParams].filter(([key]) => key !== "sign"));
    expect(query.page_token).toBe(pageToken);
    expect(url.searchParams.get("sign")).toBe(signRequest({ appSecret: APP_SECRET, path: url.pathname, query, body: "{}" }));
  });

  test("undefined query values are left out of the URL and the signature", async () => {
    const h = harness([{ body: shops }]);
    await get(h.client, { query: { page_token: undefined, page_size: 10 } });
    expect(h.calls[0]!.url.searchParams.has("page_token")).toBe(false);
  });

  test("client-owned params cannot be passed in the query", async () => {
    const h = harness([]);
    for (const key of ["app_key", "timestamp", "sign", "shop_cipher", "access_token"]) {
      await expect(get(h.client, { query: { [key]: "x" } })).rejects.toThrow(`query parameter ${key}`);
    }
    expect(h.calls).toHaveLength(0);
  });

  test("each attempt is signed with a fresh timestamp", async () => {
    const h = harness([{ status: 503, body: "" }, { body: shops }]);
    await get(h.client);
    expect(Number(h.calls[1]!.url.searchParams.get("timestamp")) - Number(h.calls[0]!.url.searchParams.get("timestamp"))).toBe(1);
    expect(h.calls[0]!.url.searchParams.get("sign")).not.toBe(h.calls[1]!.url.searchParams.get("sign"));
  });

  test("the request timeout is 10 s by default", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const h = harness([{ body: shops }]);
    await get(h.client);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(h.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("the request timeout is clamped to what is left of the time budget", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const h = harness([{ body: shops }]);
    await get(h.client, { deadline: START + 2_500 });
    expect(timeout).toHaveBeenCalledWith(2_500);
  });

  test("baseUrl must be an https origin", () => {
    for (const baseUrl of ["http://tiktok.test", "https://tiktok.test/x", "https://tiktok.test?a=1", "not a url", "ftp://tiktok.test"]) {
      expect(() => createTikTokClient({ appKey: new Secret(APP_KEY), appSecret: new Secret(APP_SECRET), baseUrl })).toThrow("https origin");
    }
    expect(() => createTikTokClient({ appKey: new Secret(APP_KEY), appSecret: new Secret(APP_SECRET), baseUrl: "https://tiktok.test/" })).not.toThrow();
  });

  test("paths with .., #, ?, spaces or no leading / are refused before any request", async () => {
    const h = harness([]);
    for (const path of ["/order/../authorization", "/order/./x", "/a#b", "/a?b=1", "/a b", "order", "/", "//a"]) {
      await expect(get(h.client, { path })).rejects.toThrow("invalid path");
    }
    expect(h.calls).toHaveLength(0);
  });
});

describe("rate limits (HTTP 429 and code 36009002)", () => {
  test("429 then success: one jittered wait within 1 s", async () => {
    const h = harness([{ status: 429, body: "" }, { body: shops }]);
    await get(h.client);
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([1_000]);
  });

  test("code 36009002 with HTTP 200 is a rate limit too", async () => {
    const h = harness([{ body: RATE_LIMITED_ENVELOPE }, { body: shops }]);
    await get(h.client);
    expect(h.calls).toHaveLength(2);
  });

  test("Retry-After (seconds) is honoured instead of the jitter", async () => {
    const h = harness([{ status: 429, body: RATE_LIMITED_ENVELOPE, headers: { "retry-after": "7" } }, { body: shops }]);
    await get(h.client);
    expect(h.sleeps).toEqual([7_000]);
  });

  test("Retry-After 0 or a past date is raised to the 1-s floor", async () => {
    const h = harness([
      { status: 429, headers: { "retry-after": "0" } },
      { status: 429, headers: { "retry-after": new Date(START - 60_000).toUTCString() } },
      { body: shops },
    ]);
    await get(h.client);
    expect(h.sleeps).toEqual([1_000, 1_000]);
  });

  test("Retry-After as an HTTP-date is honoured", async () => {
    const h = harness([{ status: 429, body: "", headers: { "retry-after": new Date(START + 9_000).toUTCString() } }, { body: shops }]);
    await get(h.client);
    expect(h.sleeps).toEqual([9_000]);
  });

  test("at most 5 tries, then rate_limited; the waits follow the seeded 1-60 s schedule", async () => {
    const h = harness(Array.from({ length: 6 }, () => ({ status: 429, body: RATE_LIMITED_ENVELOPE })));
    const error = await rejection(get(h.client));
    expect(error.kind).toBe("rate_limited");
    expect(error.code).toBe(36009002);
    expect(error.requestId).toBe("req-rl");
    expect(h.calls).toHaveLength(5);
    expect(h.sleeps).toHaveLength(4);
    const caps = [1_000, 4_000, 16_000, 60_000];
    h.sleeps.forEach((ms, index) => {
      expect(ms).toBeGreaterThanOrEqual(1_000);
      expect(ms).toBeLessThanOrEqual(caps[index]!);
    });
    // Same seed, same schedule.
    const again = harness(Array.from({ length: 6 }, () => ({ status: 429, body: RATE_LIMITED_ENVELOPE })));
    await rejection(get(again.client));
    expect(again.sleeps).toEqual(h.sleeps);
  });

  test("mixed 429 and 36009002 share the 5-try cap", async () => {
    const h = harness([{ status: 429 }, { body: RATE_LIMITED_ENVELOPE }, { status: 429 }, { body: RATE_LIMITED_ENVELOPE }, { status: 429 }, { body: shops }]);
    expect((await rejection(get(h.client))).kind).toBe("rate_limited");
    expect(h.calls).toHaveLength(5);
  });

  test("a Retry-After longer than 60 s is never shortened: give up now", async () => {
    const h = harness([{ status: 429, headers: { "retry-after": "120" } }, { body: shops }]);
    expect((await rejection(get(h.client))).kind).toBe("rate_limited");
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  test("a wait that would pass the deadline gives up instead of sleeping", async () => {
    const h = harness([{ status: 429, headers: { "retry-after": "30" } }, { body: shops }]);
    expect((await rejection(get(h.client, { deadline: START + 10_000 }))).kind).toBe("rate_limited");
    expect(h.sleeps).toEqual([]);
  });
});

describe("503 and other 5xx are not rate limits", () => {
  test("503: two short retries (1 s, 3 s), then unavailable — no jitter, no Retry-After", async () => {
    const h = harness([
      { status: 503, headers: { "retry-after": "50" } },
      { status: 503, headers: { "retry-after": "50" } },
      { status: 503, headers: { "retry-after": "50" } },
      { body: shops },
    ]);
    const error = await rejection(get(h.client));
    expect(error.kind).toBe("unavailable");
    expect(error.httpStatus).toBe(503);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([1_000, 3_000]);
  });

  test("500 is handled like 503", async () => {
    const h = harness([{ status: 500 }, { status: 502 }, { status: 500 }]);
    expect((await rejection(get(h.client))).kind).toBe("unavailable");
    expect(h.sleeps).toEqual([1_000, 3_000]);
  });

  test("503 then success", async () => {
    const h = harness([{ status: 503 }, { body: shops }]);
    await get(h.client);
    expect(h.sleeps).toEqual([1_000]);
  });

  test("a 503 carrying 36009002 is still a rate limit (the code wins)", async () => {
    const h = harness([{ status: 503, body: RATE_LIMITED_ENVELOPE }, { body: shops }]);
    await get(h.client);
    expect(h.sleeps).toEqual([1_000]);
  });

  test("5xx and 429 budgets are independent", async () => {
    const h = harness([{ status: 503 }, { status: 429 }, { status: 503 }, { status: 429 }, { body: shops }]);
    await get(h.client);
    expect(h.calls).toHaveLength(5);
  });
});

describe("network errors", () => {
  test("two retries, then network", async () => {
    const h = harness(["network-error", "network-error", "network-error", { body: shops }]);
    const error = await rejection(get(h.client));
    expect(error.kind).toBe("network");
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([1_000, 3_000]);
  });

  test("a timeout counts as a network error", async () => {
    const h = harness([], {
      timeoutMs: 5,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      sleep: async () => {},
    });
    expect((await rejection(get(h.client))).kind).toBe("network");
  });
});

describe("auth errors", () => {
  test("401: one refresh, one retry with the new token", async () => {
    const h = harness([{ status: 401, body: { code: 105002, message: "expired", request_id: "r" } }, { body: shops }]);
    const onAuthError = vi.fn(async () => new Secret(REFRESHED_TOKEN));
    await get(h.client, { onAuthError });
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect((h.calls[1]!.init.headers as Record<string, string>)["x-tts-access-token"]).toBe(REFRESHED_TOKEN);
  });

  test("still unauthorized after the refresh → reauth_required, no second refresh", async () => {
    const h = harness([{ status: 401 }, { status: 401 }, { body: shops }]);
    const onAuthError = vi.fn(async () => new Secret(REFRESHED_TOKEN));
    expect((await rejection(get(h.client, { onAuthError }))).kind).toBe("reauth_required");
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(2);
  });

  test("no refresher → reauth_required at once", async () => {
    const h = harness([{ status: 401 }]);
    expect((await rejection(get(h.client))).kind).toBe("reauth_required");
  });

  test("a refresher failing for another reason (a DB blip) → refresh_failed, not reauth_required", async () => {
    const h = harness([{ status: 401 }]);
    const error = await rejection(get(h.client, { onAuthError: async () => Promise.reject(new Error(`db down ${ACCESS_TOKEN}`)) }));
    expect(error.kind).toBe("refresh_failed");
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(ACCESS_TOKEN);
  });

  test("a refresher saying the refresh token is invalid → reauth_required, passed through", async () => {
    const h = harness([{ status: 401 }]);
    const invalid = new TikTokApiError({ kind: "reauth_required", path: "/api/v2/token/refresh", httpStatus: 200, code: 1, requestId: null });
    expect(await rejection(get(h.client, { onAuthError: async () => Promise.reject(invalid) }))).toBe(invalid);
  });

  test("a refresher hitting a TikTok outage keeps that kind", async () => {
    const h = harness([{ status: 401 }]);
    const outage = new TikTokApiError({ kind: "unavailable", path: "/api/v2/token/refresh", httpStatus: 503, code: null, requestId: null });
    expect((await rejection(get(h.client, { onAuthError: async () => Promise.reject(outage) }))).kind).toBe("unavailable");
  });

  test("a configured auth code with HTTP 200 triggers the refresh", async () => {
    const h = harness([{ body: { code: 105001, request_id: "r" } }, { body: shops }], { authErrorCodes: new Set([105001]) });
    const onAuthError = vi.fn(async () => new Secret(REFRESHED_TOKEN));
    await get(h.client, { onAuthError });
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });
});

describe("other outcomes", () => {
  test("any other non-zero code → api error with code and request id, no retry", async () => {
    const h = harness([{ body: { code: 12019001, message: "bad param", request_id: "req-x" } }, { body: shops }]);
    const error = await rejection(get(h.client));
    expect(error.toJSON()).toEqual({ kind: "api", path: "/authorization/202309/shops", httpStatus: 200, code: 12019001, requestId: "req-x" });
    expect(h.calls).toHaveLength(1);
  });

  test("4xx with an envelope → api error, no retry", async () => {
    const h = harness([{ status: 400, body: { code: 36009004, request_id: "r4" } }]);
    const error = await rejection(get(h.client));
    expect([error.kind, error.httpStatus, error.code]).toEqual(["api", 400, 36009004]);
  });

  test("a configured clock-skew code → clock_skew, no retry", async () => {
    const h = harness([{ body: { code: 36009003, request_id: "r" } }], { clockSkewCodes: new Set([36009003]) });
    expect((await rejection(get(h.client))).kind).toBe("clock_skew");
    expect(h.calls).toHaveLength(1);
  });

  test("a 200 that is not JSON, or not the envelope → invalid_response", async () => {
    for (const body of ["<html>", "{}", '{"code":"0"}', "[]"]) {
      const h = harness([{ body }]);
      expect((await rejection(get(h.client))).kind).toBe("invalid_response");
    }
  });

  test("data failing the caller's schema → invalid_response", async () => {
    const h = harness([{ body: ok({ shops: [{ id: 1 }] }) }]);
    expect((await rejection(get(h.client))).kind).toBe("invalid_response");
  });

  test("the time budget: no attempt is started after the deadline", async () => {
    const h = harness([{ body: shops }]);
    h.advance(1_000);
    const error = await rejection(get(h.client, { deadline: START }));
    expect(error.kind).toBe("budget_exhausted");
    expect(h.calls).toHaveLength(0);
  });

  test("the time budget: a short retry that would pass the deadline is not slept", async () => {
    const h = harness([{ status: 503 }, { body: shops }]);
    expect((await rejection(get(h.client, { deadline: START + 500 }))).kind).toBe("unavailable");
    expect(h.sleeps).toEqual([]);
  });
});

describe("no secret in errors or logs (§7.1)", () => {
  test("failing calls, a refresh and errors print no secret, token, sign, app key or URL", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg))).join(" "));
      });
    }
    const h = harness([
      "network-error",
      "network-error",
      "network-error",
      { status: 401, body: { code: 1, message: `echo ${ACCESS_TOKEN}`, request_id: "r" } },
      { status: 401 },
      { status: 400, body: { code: 2, message: `bad sign for ${APP_KEY}`, request_id: "r" } },
    ]);
    const errors: unknown[] = [];
    for (const extra of [{}, { onAuthError: async () => new Secret(REFRESHED_TOKEN) }, {}]) {
      try {
        await get(h.client, extra);
      } catch (error) {
        errors.push(error);
        console.error("tiktok call failed", error);
      }
    }
    expect(errors).toHaveLength(3);
    const signs = h.calls.map((call) => call.url.searchParams.get("sign")!);
    const text = [
      ...lines,
      ...errors.flatMap((error) => [String(error), JSON.stringify(error), (error as Error).stack ?? "", (error as Error).message]),
    ].join("\n");
    for (const needle of [APP_SECRET, APP_KEY, ACCESS_TOKEN, REFRESHED_TOKEN, "tiktok.test", "?", ...signs]) {
      expect(text).not.toContain(needle);
    }
  });
});
