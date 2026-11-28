import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { StaffSessionData } from "@ammari/auth/staff";
import { createTikTokOAuthState, tiktokRuntimeFromEnv } from "@ammari/commerce/tiktok";
import { auditLog, tiktokOauthStates, tiktokShopConnections } from "@ammari/db/schema";
import { insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import type { FetchLike } from "@ammari/tiktok-shop";
import { handleTikTokCallback } from "./tiktok";
import { TIKTOK_CONNECT_ERRORS } from "./tiktok-messages";

// The OAuth callback (docs/plans/tiktok-shop-integration.md §7.3, T2): permission first, state once
// per staff user, code exchanged, shops read, connection saved; every failure an Indonesian message
// code, never TikTok's body; no code, state, token or secret in any log line. TikTok's auth host and
// API are an in-memory fake (nothing leaves the process); the database is ammari_test, rolled back.

const NOW = new Date("2026-11-27T03:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const ENV = {
  TIKTOK_APP_KEY: "dummyappkey",
  TIKTOK_APP_SECRET: "dummyappsecret0123456789",
  TIKTOK_SERVICE_ID: "7000000000000000999",
  TIKTOK_TOKEN_ENC_KEY_V1: Buffer.alloc(32, 5).toString("base64"),
  TIKTOK_TOKEN_ENC_KEY_CURRENT: "1",
};
const GOOD_CODE = "ROW_good_code_123";
const SHOP = { id: "7000000000000000001", cipher: "ROW_cipher_secretish", name: "Ammari", region: "ID", seller_type: "LOCAL" };

type Scenario = { token?: "ok" | "rejected" | "403" | "503"; tokenData?: Record<string, unknown>; shops?: unknown[] };

function fakeTikTok(scenario: Scenario = {}) {
  const calls: URL[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname === "/api/v2/token/get") {
      if (scenario.token === "503") return new Response("down", { status: 503 });
      if (scenario.token === "403") return Response.json({ code: 105002, message: "invalid app secret", request_id: "req-403" }, { status: 403 });
      if (scenario.token === "rejected" || url.searchParams.get("auth_code") !== GOOD_CODE) {
        return Response.json({ code: 36004004, message: `auth_code ${url.searchParams.get("auth_code")} expired`, request_id: "req-used" });
      }
      return Response.json({
        code: 0,
        request_id: "req-token",
        data: {
          access_token: "ROW_access_token_value",
          access_token_expire_in: NOW_S + 7 * 86_400,
          refresh_token: "ROW_refresh_token_value",
          refresh_token_expire_in: NOW_S + 365 * 86_400,
          granted_scopes: ["seller.order.info"],
          ...scenario.tokenData,
        },
      });
    }
    if (url.pathname === "/authorization/202309/shops") return Response.json({ code: 0, request_id: "req-shops", data: { shops: scenario.shops ?? [SHOP] } });
    throw new Error(`unexpected ${url.pathname}`);
  };
  return { runtime: tiktokRuntimeFromEnv(ENV, { fetch, now: () => NOW.getTime() }), calls };
}

function session(staffUserId: string, permissionKeys = ["integrations.manage"]): StaffSessionData {
  return {
    staffUser: { id: staffUserId, name: "Staf Uji", email: "staf@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test", name: "Test" },
    permissionKeys,
  } as unknown as StaffSessionData;
}

function callbackUrl(params: Record<string, string>): URL {
  return new URL(`https://admin.test/api/integrations/tiktok/callback?${new URLSearchParams(params).toString()}`);
}

async function start(tx: TestTx, staffUserId: string): Promise<string> {
  return (await createTikTokOAuthState(tx, staffUserId, NOW)).reveal();
}

function captureLogs(): string[] {
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    });
  }
  return lines;
}

const SECRETS = [GOOD_CODE, "ROW_access_token_value", "ROW_refresh_token_value", ENV.TIKTOK_APP_SECRET, ENV.TIKTOK_APP_KEY, "ROW_cipher_secretish"];

function errorOf(response: Response): string | null {
  return new URL(response.headers.get("location")!, "https://admin.test").searchParams.get("error");
}

/** Raw states created in a test, so the log assertions can check none of them was printed. */
const states: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  states.length = 0;
});

describe("permission (403 before anything is read or consumed)", () => {
  test("no staff session (a customer session never is one) and staff without integrations.manage → 403, state untouched", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const state = await start(tx, staff.id);
      const { runtime, calls } = fakeTikTok();
      for (const who of [null, session(staff.id, ["settings.manage", "orders.manage"])]) {
        const response = await handleTikTokCallback({ url: callbackUrl({ code: GOOD_CODE, state }), session: who, db: tx, runtime, now: NOW });
        expect(response.status).toBe(403);
      }
      expect(calls).toEqual([]);
      const [stored] = await tx.select().from(tiktokOauthStates).where(eq(tiktokOauthStates.staffUserId, staff.id));
      expect(stored!.usedAt).toBeNull();
    });
  });
});

describe("successful connect", () => {
  test("exchanges the code (authorized_code), reads the shop, stores encrypted tokens, audits, redirects", async () => {
    const logs = captureLogs();
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const state = await start(tx, staff.id);
      states.push(state);
      const { runtime, calls } = fakeTikTok();
      const response = await handleTikTokCallback({ url: callbackUrl({ code: GOOD_CODE, state }), session: session(staff.id), db: tx, runtime, now: NOW });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/settings/integrations/tiktok?connected=new");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(calls.map((url) => url.pathname)).toEqual(["/api/v2/token/get", "/authorization/202309/shops"]);
      expect(calls[0]!.searchParams.get("grant_type")).toBe("authorized_code");

      const [row] = await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.shopId, SHOP.id));
      expect(row!.status).toBe("active");
      expect(row!.shopCipher).toBe(SHOP.cipher);
      expect(row!.connectedByStaffUserId).toBe(staff.id);
      expect(row!.accessTokenCt!.toString("latin1")).not.toContain("ROW_access_token_value");
      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "tiktok_shop_connection"), eq(auditLog.entityId, row!.id)));
      expect(audit!.action).toBe("tiktok_connect");

      // The same state again (a replayed callback) is refused, and TikTok is not called again.
      const replay = await handleTikTokCallback({ url: callbackUrl({ code: GOOD_CODE, state }), session: session(staff.id), db: tx, runtime, now: NOW });
      expect(errorOf(replay)).toBe("state_invalid");
      expect(calls).toHaveLength(2);

      // A second, fresh connect of the same shop is a reconnect.
      const again = await handleTikTokCallback({ url: callbackUrl({ code: GOOD_CODE, state: await start(tx, staff.id) }), session: session(staff.id), db: tx, runtime, now: NOW });
      expect(again.headers.get("location")).toBe("/settings/integrations/tiktok?connected=again");
    });
    const text = logs.join("\n");
    expect(text).toContain("[tiktok-connect] connected");
    expect(text).not.toContain("droppedFields");
    for (const secret of [...SECRETS, ...states]) expect(text).not.toContain(secret);
  });
});

// T0 (dev, 28 Nov 2026): TikTok answered 200 / code 0 with a refresh expiry past our old 10-year cap,
// and the connect failed as invalid_response with nothing in the log to say why.
describe("T0: token response shapes", () => {
  const year2100S = Date.UTC(2100, 0, 1) / 1000;

  test("a refresh expiry in 2100 and overlong optional fields still connect; the expiry is stored as is", async () => {
    const logs = captureLogs();
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const state = await start(tx, staff.id);
      states.push(state);
      const { runtime } = fakeTikTok({
        tokenData: { refresh_token_expire_in: year2100S, open_id: "OPENID_secretish", seller_name: "N".repeat(600), seller_base_region: "ID", user_type: 0 },
      });
      const response = await handleTikTokCallback({ url: callbackUrl({ code: GOOD_CODE, state }), session: session(staff.id), db: tx, runtime, now: NOW });
      expect(response.headers.get("location")).toBe("/settings/integrations/tiktok?connected=new");
      const [row] = await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.shopId, SHOP.id));
      expect(row!.refreshTokenExpiresAt!.toISOString()).toBe("2100-01-01T00:00:00.000Z");
    });
    const text = logs.join("\n");
    expect(text).toContain('"droppedFields":["seller_name"]');
    for (const secret of [...SECRETS, ...states, "OPENID_secretish", "NNNN"]) expect(text).not.toContain(secret);
  });

  test.each([
    ["a refresh expiry after 2200", { refresh_token_expire_in: Date.UTC(2205, 0, 1) / 1000 }, "expiry:refresh:beyond_cap:2205"],
    ["an access expiry 40 days ahead", { access_token_expire_in: NOW_S + 40 * 86_400 }, "expiry:access:beyond_cap:2027"],
    ["a relative access lifetime", { access_token_expire_in: 604_800 }, "expiry:access:relative:1970"],
    ["a missing refresh token", { refresh_token: undefined }, "schema:refresh_token:invalid_type"],
  ])("%s → invalid_response, and the log line names the cause (%s), never a value", async (_name, tokenData, detail) => {
    const logs = captureLogs();
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const state = await start(tx, staff.id);
      states.push(state);
      const { runtime } = fakeTikTok({ tokenData });
      const response = await handleTikTokCallback({ url: callbackUrl({ code: GOOD_CODE, state }), session: session(staff.id), db: tx, runtime, now: NOW });
      expect(errorOf(response)).toBe("invalid_response");
      expect(await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.shopId, SHOP.id))).toHaveLength(0);
    });
    const text = logs.join("\n");
    expect(text).toContain("[tiktok-connect] failed");
    expect(text).toContain(`"detail":"${detail}"`);
    expect(text).toContain('"requestId":"req-token"');
    const numbers = Object.values(tokenData).filter((value): value is number => typeof value === "number").map(String);
    for (const secret of [...SECRETS, ...states, ...numbers]) expect(text).not.toContain(secret);
  });
});

describe("failures map to an Indonesian message code, never TikTok's body", () => {
  test.each([
    ["TikTok refuses the code (used or expired)", { token: "rejected" as const }, "code_rejected"],
    ["TikTok 503", { token: "503" as const }, "tiktok_unavailable"],
    ["a non-200 refusal (setup problem, e.g. a wrong app secret), not the person's code", { token: "403" as const }, "failed"],
    ["no shop authorized", { shops: [] }, "no_shop"],
    ["two shops authorized", { shops: [SHOP, { ...SHOP, id: "7000000000000000002" }] }, "multiple_shops"],
  ])("%s → %s", async (_name, scenario, code) => {
    const logs = captureLogs();
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const { runtime } = fakeTikTok(scenario);
      const state = await start(tx, staff.id);
      states.push(state);
      const response = await handleTikTokCallback({ url: callbackUrl({ code: GOOD_CODE, state }), session: session(staff.id), db: tx, runtime, now: NOW });
      expect(response.status).toBe(303);
      expect(errorOf(response)).toBe(code);
      expect(await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.shopId, SHOP.id))).toHaveLength(0);
    });
    const text = logs.join("\n");
    expect(text).toContain(`"reason":"${code}"`);
    expect(text).not.toContain("expired");
    for (const secret of [...SECRETS, ...states]) expect(text).not.toContain(secret);
  });

  test("a state started by another staff user, an expired state, a missing state", async () => {
    await withRollback(async (tx) => {
      const owner = await insertStaffUser(tx);
      const other = await insertStaffUser(tx);
      const { runtime, calls } = fakeTikTok();
      const state = await start(tx, owner.id);
      const otherStaff = await handleTikTokCallback({ url: callbackUrl({ code: GOOD_CODE, state }), session: session(other.id), db: tx, runtime, now: NOW });
      expect(errorOf(otherStaff)).toBe("state_invalid");
      const late = new Date(NOW.getTime() + 11 * 60_000);
      const expired = await handleTikTokCallback({ url: callbackUrl({ code: GOOD_CODE, state }), session: session(owner.id), db: tx, runtime, now: late });
      expect(errorOf(expired)).toBe("state_invalid");
      const missing = await handleTikTokCallback({ url: callbackUrl({ code: GOOD_CODE }), session: session(owner.id), db: tx, runtime, now: NOW });
      expect(errorOf(missing)).toBe("missing_params");
      expect(calls).toEqual([]);
    });
  });

  test("a valid state without a code burns the state; not configured is reported, without calling TikTok", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const { runtime, calls } = fakeTikTok();
      const state = await start(tx, staff.id);
      expect(errorOf(await handleTikTokCallback({ url: callbackUrl({ state }), session: session(staff.id), db: tx, runtime, now: NOW }))).toBe("missing_params");
      expect(errorOf(await handleTikTokCallback({ url: callbackUrl({ code: GOOD_CODE, state }), session: session(staff.id), db: tx, runtime, now: NOW }))).toBe("state_invalid");
      const notConfigured = tiktokRuntimeFromEnv({});
      expect(
        errorOf(await handleTikTokCallback({ url: callbackUrl({ code: GOOD_CODE, state: await start(tx, staff.id) }), session: session(staff.id), db: tx, runtime: notConfigured, now: NOW })),
      ).toBe("not_configured");
      expect(calls).toEqual([]);
    });
  });
});

describe("messages", () => {
  test("every code has an Indonesian message without an em dash", () => {
    for (const message of Object.values(TIKTOK_CONNECT_ERRORS)) {
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toContain("—");
    }
    expect(TIKTOK_CONNECT_ERRORS.code_rejected).toBe("Kode sudah dipakai, ulangi Hubungkan.");
  });
});
