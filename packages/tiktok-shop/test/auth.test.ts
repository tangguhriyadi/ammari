import { describe, expect, test, vi } from "vitest";
import { buildAuthorizeUrl, createTikTokAuthClient } from "../src/auth";
import { TikTokApiError, createTikTokClient, type FetchLike } from "../src/client";
import { tiktokConfigFromEnv } from "../src/config";
import { Secret } from "../src/secret";
import { getAuthorizedShops } from "../src/shops";

// The auth host and Get Authorized Shops, against in-memory fakes only (test/setup.ts blocks the
// global fetch). Dummy credentials; never real ones.

const APP_KEY = "dummyappkey";
const APP_SECRET = "dummyappsecret0123456789";
const SERVICE_ID = "7000000000000000999";
const NOW = Date.UTC(2026, 10, 27, 3, 0, 0);
const NOW_S = NOW / 1000;

function tokenBody(overrides: Record<string, unknown> = {}) {
  return {
    code: 0,
    message: "success",
    request_id: "req-token",
    data: {
      access_token: "ROW_dummy_access",
      access_token_expire_in: NOW_S + 7 * 86_400,
      refresh_token: "ROW_dummy_refresh",
      refresh_token_expire_in: NOW_S + 60 * 86_400,
      open_id: "open-1",
      seller_name: "Ammari Test",
      seller_base_region: "ID",
      granted_scopes: ["seller.shop.info", "seller.order.info", "seller.order.info"],
      user_type: 0,
      ...overrides,
    },
  };
}

function harness(reply: { status?: number; body?: unknown } | "network-error") {
  const calls: URL[] = [];
  const fetch: FetchLike = async (input) => {
    calls.push(new URL(input));
    if (reply === "network-error") throw new TypeError(`fetch failed: ${input}`);
    return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  const client = createTikTokAuthClient({ appKey: new Secret(APP_KEY), appSecret: new Secret(APP_SECRET), baseUrl: "https://auth.test", fetch, now: () => NOW });
  return { client, calls };
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

describe("buildAuthorizeUrl", () => {
  test("uses TIKTOK_SERVICE_ID as service_id and never the App Key", () => {
    const config = tiktokConfigFromEnv(
      {
        TIKTOK_APP_KEY: APP_KEY,
        TIKTOK_APP_SECRET: APP_SECRET,
        TIKTOK_SERVICE_ID: SERVICE_ID,
        TIKTOK_TOKEN_ENC_KEY_V1: Buffer.alloc(32, 1).toString("base64"),
        TIKTOK_TOKEN_ENC_KEY_CURRENT: "1",
      },
      { requireServiceId: true },
    );
    if (!config.configured) throw new Error("expected a configured config");
    const url = new URL(buildAuthorizeUrl({ serviceId: config.config.serviceId!, state: new Secret("state_abc-123") }));
    expect(url.origin + url.pathname).toBe("https://services.tiktokshop.com/open/authorize");
    expect(url.searchParams.get("service_id")).toBe(SERVICE_ID);
    expect(url.searchParams.get("state")).toBe("state_abc-123");
    expect(url.toString()).not.toContain(APP_KEY);
    expect([...url.searchParams.keys()].sort()).toEqual(["service_id", "state"]);
  });

  test("refuses a non-numeric service id (an App Key pasted by mistake)", () => {
    expect(() => buildAuthorizeUrl({ serviceId: APP_KEY, state: new Secret("s") })).toThrow(/numeric Partner Center app ID/);
  });
});

describe("token get / refresh", () => {
  test("token get: grant_type=authorized_code, the code as auth_code, parsed and wrapped in Secret", async () => {
    const h = harness({ body: tokenBody() });
    const tokens = await h.client.getAccessToken(new Secret("one-time-code"));
    const url = h.calls[0]!;
    expect(url.origin + url.pathname).toBe("https://auth.test/api/v2/token/get");
    expect(url.searchParams.get("grant_type")).toBe("authorized_code");
    expect(url.searchParams.get("auth_code")).toBe("one-time-code");
    expect(url.searchParams.get("app_key")).toBe(APP_KEY);
    expect(tokens.accessToken).toBeInstanceOf(Secret);
    expect(tokens.accessToken.reveal()).toBe("ROW_dummy_access");
    expect(tokens.refreshToken.reveal()).toBe("ROW_dummy_refresh");
    expect(tokens.accessTokenExpiresAt.toISOString()).toBe(new Date(NOW + 7 * 86_400_000).toISOString());
    expect(tokens.refreshTokenExpiresAt.toISOString()).toBe(new Date(NOW + 60 * 86_400_000).toISOString());
    expect(tokens.grantedScopes).toEqual(["seller.order.info", "seller.shop.info"]);
    expect(JSON.stringify(tokens)).not.toContain("ROW_dummy");
  });

  test("refresh: grant_type=refresh_token at /api/v2/token/refresh", async () => {
    const h = harness({ body: tokenBody({ access_token: "ROW_new_access" }) });
    const tokens = await h.client.refreshAccessToken(new Secret("ROW_old_refresh"));
    expect(h.calls[0]!.pathname).toBe("/api/v2/token/refresh");
    expect(h.calls[0]!.searchParams.get("grant_type")).toBe("refresh_token");
    expect(h.calls[0]!.searchParams.get("refresh_token")).toBe("ROW_old_refresh");
    expect(tokens.accessToken.reveal()).toBe("ROW_new_access");
  });

  test("a non-zero code (a used or expired code) is `api` with the code, never the message or the URL", async () => {
    const h = harness({ body: { code: 36004004, message: "auth code ROW_secret_echo is invalid", request_id: "req-x" } });
    const error = await rejection(h.client.getAccessToken(new Secret("used-code")));
    expect(error.toJSON()).toEqual({ kind: "api", path: "/api/v2/token/get", httpStatus: 200, code: 36004004, requestId: "req-x" });
    for (const leak of ["used-code", APP_SECRET, "ROW_secret_echo", "auth.test"]) {
      expect(error.message).not.toContain(leak);
      expect(JSON.stringify(error)).not.toContain(leak);
    }
  });

  test.each([
    ["429", { status: 429, body: {} }, "rate_limited"],
    ["rate-limit code", { body: { code: 36009002 } }, "rate_limited"],
    ["503", { status: 503, body: "oops" }, "unavailable"],
    ["not JSON", { body: "<html>" }, "invalid_response"],
    ["4xx without envelope", { status: 400, body: "<html>" }, "api"],
  ] as const)("%s → %s, no retry", async (_name, reply, kind) => {
    const h = harness(reply);
    expect((await rejection(h.client.getAccessToken(new Secret("c")))).kind).toBe(kind);
    expect(h.calls).toHaveLength(1);
  });

  test("a network error is `network` and drops the URL (it holds the app secret)", async () => {
    const h = harness("network-error");
    const error = await rejection(h.client.refreshAccessToken(new Secret("r")));
    expect(error.kind).toBe("network");
    expect(error.message).not.toContain(APP_SECRET);
  });

  test.each([
    ["a relative lifetime instead of a timestamp", { access_token_expire_in: 604_800 }],
    ["an expiry in the past", { refresh_token_expire_in: NOW_S - 1 }],
    ["a missing refresh token", { refresh_token: undefined }],
    ["an empty access token", { access_token: "" }],
  ])("%s → invalid_response, nothing guessed", async (_name, overrides) => {
    const h = harness({ body: tokenBody(overrides) });
    expect((await rejection(h.client.getAccessToken(new Secret("c")))).kind).toBe("invalid_response");
  });

  test("refuses a non-https base URL", () => {
    expect(() => createTikTokAuthClient({ appKey: new Secret(APP_KEY), appSecret: new Secret(APP_SECRET), baseUrl: "http://auth.test" })).toThrow(/https origin/);
  });
});

describe("getAuthorizedShops", () => {
  test("signed GET with the token header; keeps id, cipher, name, region, seller type only", async () => {
    const calls: { url: URL; headers: Headers }[] = [];
    const fetch = vi.fn<FetchLike>(async (input, init) => {
      calls.push({ url: new URL(input), headers: new Headers(init.headers) });
      return new Response(
        JSON.stringify({
          code: 0,
          request_id: "r",
          data: { shops: [{ id: "7000000000000000001", cipher: "ROW_cipher", name: "Ammari", region: "ID", seller_type: "LOCAL", code: "IDLC123", extra: "x" }] },
        }),
      );
    });
    const client = createTikTokClient({ appKey: new Secret(APP_KEY), appSecret: new Secret(APP_SECRET), baseUrl: "https://api.test", fetch, now: () => NOW });
    const shops = await getAuthorizedShops(client, new Secret("ROW_access"));
    expect(shops).toEqual([{ shopId: "7000000000000000001", shopCipher: "ROW_cipher", shopName: "Ammari", region: "ID", sellerType: "LOCAL" }]);
    expect(calls[0]!.url.pathname).toBe("/authorization/202309/shops");
    expect(calls[0]!.headers.get("x-tts-access-token")).toBe("ROW_access");
    expect(calls[0]!.url.searchParams.has("access_token")).toBe(false);
  });
});
