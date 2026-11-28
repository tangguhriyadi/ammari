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
const yearS = (year: number) => Date.UTC(year, 0, 1) / 1000;

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

// T0 (28 Nov 2026, dev): HTTP 200, code 0, refused as invalid_response with no way to tell why. Each
// refusal now carries a `detail` naming the cause: never a value, only the field path and zod's
// issue code, or which expiry, why, and its year.
describe("invalid_response detail (T0 diagnostics)", () => {
  async function detailOf(body: unknown, call: "get" | "refresh" = "get") {
    const h = harness({ body });
    const promise = call === "get" ? h.client.getAccessToken(new Secret("c")) : h.client.refreshAccessToken(new Secret("r"));
    const error = await rejection(promise);
    expect(error.kind).toBe("invalid_response");
    expect(error.toJSON().detail).toBe(error.detail);
    return error.detail;
  }

  test("a 200 whose body is not the envelope → envelope_unparsable", async () => {
    expect(await detailOf("<html>")).toBe("envelope_unparsable");
    expect(await detailOf({ data: {} })).toBe("envelope_unparsable");
  });

  test.each([
    ["a missing refresh token", { refresh_token: undefined }, "schema:refresh_token:invalid_type"],
    ["an empty access token", { access_token: "" }, "schema:access_token:too_small"],
    ["an expiry sent as a string", { access_token_expire_in: String(NOW_S + 3600) }, "schema:access_token_expire_in:invalid_type"],
    ["a fractional expiry", { refresh_token_expire_in: NOW_S + 0.5 }, "schema:refresh_token_expire_in:invalid_type"],
    ["two failing fields", { access_token: undefined, refresh_token_expire_in: null }, "schema:access_token:invalid_type;schema:refresh_token_expire_in:invalid_type"],
  ])("%s → %s", async (_name, overrides, detail) => {
    expect(await detailOf(tokenBody(overrides))).toBe(detail);
  });

  test("data that is not an object → schema:(root):invalid_type", async () => {
    expect(await detailOf({ code: 0, request_id: "r", data: null })).toBe("schema:(root):invalid_type");
  });

  test.each([
    ["access relative", { access_token_expire_in: 604_800 }, "expiry:access:relative:1970"],
    ["access in the past", { access_token_expire_in: NOW_S - 60 }, "expiry:access:past:2026"],
    ["access now (not in the future)", { access_token_expire_in: NOW_S }, "expiry:access:past:2026"],
    ["access more than 30 days ahead", { access_token_expire_in: NOW_S + 30 * 86_400 + 1 }, "expiry:access:beyond_cap:2026"],
    ["access in 2100", { access_token_expire_in: yearS(2100) }, "expiry:access:beyond_cap:2100"],
    ["refresh relative", { refresh_token_expire_in: 31_536_000 }, "expiry:refresh:relative:1971"],
    ["refresh in the past", { refresh_token_expire_in: NOW_S - 1 }, "expiry:refresh:past:2026"],
    ["refresh after 2200", { refresh_token_expire_in: yearS(2201) }, "expiry:refresh:beyond_cap:2201"],
    ["refresh absurdly far", { refresh_token_expire_in: Number.MAX_SAFE_INTEGER }, "expiry:refresh:beyond_cap:out_of_range"],
  ])("%s → %s", async (_name, overrides, detail) => {
    expect(await detailOf(tokenBody(overrides))).toBe(detail);
    expect(await detailOf(tokenBody(overrides), "refresh")).toBe(detail);
  });

  test("the access expiry is checked first and reported alone", async () => {
    expect(await detailOf(tokenBody({ access_token_expire_in: 1, refresh_token_expire_in: 2 }))).toBe("expiry:access:relative:1970");
  });

  test("the detail never quotes a value: no token, no full expiry number, no name", async () => {
    const far = yearS(2300) + 12_345;
    const h = harness({ body: tokenBody({ access_token: "ROW_leak_access", refresh_token: "ROW_leak_refresh", refresh_token_expire_in: far, seller_name: "Toko Rahasia" }) });
    const error = await rejection(h.client.getAccessToken(new Secret("code-leak")));
    const text = [error.message, JSON.stringify(error), String(error.detail)].join("\n");
    for (const leak of ["ROW_leak", String(far), "Toko Rahasia", "code-leak", APP_SECRET]) expect(text).not.toContain(leak);
    expect(error.detail).toBe("expiry:refresh:beyond_cap:2300");
  });

  test("errors other than invalid_response carry no detail", async () => {
    const h = harness({ body: { code: 36004004, request_id: "req-x" } });
    const error = await rejection(h.client.getAccessToken(new Secret("c")));
    expect(error.detail).toBeNull();
    expect(error.toJSON()).not.toHaveProperty("detail");
  });
});

// T0: refresh_token_expire_in "equals the authorization duration the user granted", which can be far
// in the future. Stored as is (timestamptz) up to the year 2200; the access token stays strict.
describe("expiry bounds", () => {
  test.each([
    ["2100", yearS(2100)],
    ["the last second of 2200", yearS(2201) - 1],
  ])("a refresh expiry in %s is accepted and stored as is (token get and refresh)", async (_name, seconds) => {
    for (const call of ["get", "refresh"] as const) {
      const h = harness({ body: tokenBody({ refresh_token_expire_in: seconds }) });
      const tokens = call === "get" ? await h.client.getAccessToken(new Secret("c")) : await h.client.refreshAccessToken(new Secret("r"));
      expect(tokens.refreshTokenExpiresAt.getTime()).toBe(seconds * 1000);
    }
  });

  test("an access expiry exactly 30 days ahead is accepted", async () => {
    const h = harness({ body: tokenBody({ access_token_expire_in: NOW_S + 30 * 86_400 }) });
    expect((await h.client.getAccessToken(new Secret("c"))).accessTokenExpiresAt.getTime()).toBe(NOW + 30 * 86_400_000);
  });
});

// T0: optional fields must never block a connect. Too long or the wrong type → dropped (null / left
// out of the scopes); unknown fields ignored. Only the tokens and both expiries are required.
describe("lenient optional fields", () => {
  test.each(["get", "refresh"] as const)("%s: overlong or mistyped optional fields are dropped, not fatal", async (call) => {
    const h = harness({
      body: tokenBody({
        open_id: "o".repeat(5_000),
        seller_name: "n".repeat(513),
        seller_base_region: "r".repeat(17),
        granted_scopes: ["seller.order.info", "s".repeat(129), 42, "seller.finance.info", null],
        user_type: 1,
        some_future_field: { nested: true },
      }),
    });
    const tokens = call === "get" ? await h.client.getAccessToken(new Secret("c")) : await h.client.refreshAccessToken(new Secret("r"));
    expect(tokens.accessToken.reveal()).toBe("ROW_dummy_access");
    expect(tokens.sellerName).toBeNull();
    expect(tokens.sellerBaseRegion).toBeNull();
    expect(tokens.grantedScopes).toEqual(["seller.finance.info", "seller.order.info"]);
    expect(tokens.droppedFields).toEqual(["granted_scopes", "open_id", "seller_base_region", "seller_name"]);
  });

  test("optional fields of the wrong type (array, number, object, string for a list) are dropped too", async () => {
    const h = harness({ body: tokenBody({ open_id: ["o"], seller_name: 7, seller_base_region: { a: 1 }, granted_scopes: "seller.order.info" }) });
    const tokens = await h.client.getAccessToken(new Secret("c"));
    expect(tokens.sellerName).toBeNull();
    expect(tokens.sellerBaseRegion).toBeNull();
    expect(tokens.grantedScopes).toEqual([]);
    expect(tokens.droppedFields).toEqual(["granted_scopes", "open_id", "seller_base_region", "seller_name"]);
  });

  test.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
  ])("%s optional fields are fine and drop nothing", async (_name, value) => {
    const h = harness({ body: tokenBody({ open_id: value, seller_name: value, seller_base_region: value, granted_scopes: value === "" ? [] : value, user_type: value }) });
    const tokens = await h.client.getAccessToken(new Secret("c"));
    expect(tokens).toMatchObject({ sellerName: null, sellerBaseRegion: null, grantedScopes: [], droppedFields: [] });
  });

  test("the well-formed case keeps the name and region and drops nothing", async () => {
    const tokens = await harness({ body: tokenBody() }).client.getAccessToken(new Secret("c"));
    expect(tokens).toMatchObject({ sellerName: "Ammari Test", sellerBaseRegion: "ID", droppedFields: [] });
  });

  test("more than 200 scopes: the first 200 valid ones are kept, the rest dropped", async () => {
    const scopes = Array.from({ length: 250 }, (_, i) => `scope.${String(i).padStart(3, "0")}`);
    const tokens = await harness({ body: tokenBody({ granted_scopes: scopes }) }).client.getAccessToken(new Secret("c"));
    expect(tokens.grantedScopes).toHaveLength(200);
    expect(tokens.droppedFields).toEqual(["granted_scopes"]);
  });

  test.each([
    ["an access token over 4096 characters", { access_token: "a".repeat(4097) }, "schema:access_token:too_big"],
    ["a refresh token that is a number", { refresh_token: 12345 }, "schema:refresh_token:invalid_type"],
  ])("required fields stay strict: %s", async (_name, overrides, detail) => {
    const error = await rejection(harness({ body: tokenBody(overrides) }).client.getAccessToken(new Secret("c")));
    expect(error.detail).toBe(detail);
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
