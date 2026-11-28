import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { auditLog, staffUsers, tiktokOauthStates, tiktokShopConnections } from "@ammari/db/schema";
import { insertStaffUser } from "@ammari/db/test-fixtures";
import { testDb, withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { Secret, TikTokApiError, decryptToken, type TikTokAuthClient, type TikTokTokenSet, type TokenKeyring } from "@ammari/tiktok-shop";
import {
  consumeTikTokOAuthState,
  createTikTokOAuthState,
  deauthorizeTikTokShop,
  disconnectTikTokShop,
  getTikTokConnectionView,
  loadTikTokCredentials,
  recordTikTokExpiryWarning,
  refreshTikTokToken,
  saveTikTokConnection,
  tiktokAuthErrorRefresher,
} from "./connection";

// docs/plans/tiktok-shop-integration.md T2 (DB): state consumed once, expired or other-staff state
// refused, refresh race (one TikTok call, one write, generation + 1), deauth wipes the ciphertext.
// TikTok is an in-memory fake; dummy tokens only.

const NOW = new Date("2026-11-27T03:00:00.000Z");
const DAY = 86_400_000;
const KEYRING: TokenKeyring = { currentVersion: 1, keys: new Map([[1, new Secret(new Uint8Array(32).fill(7))]]) };
const OTHER_KEYRING: TokenKeyring = { currentVersion: 1, keys: new Map([[1, new Secret(new Uint8Array(32).fill(9))]]) };
const SHOP = { shopId: "7000000000000000001", shopCipher: "ROW_cipher_1", shopName: "Ammari", region: "ID", sellerType: "LOCAL" };

function tokenSet(suffix: string, now = NOW): TikTokTokenSet {
  return {
    accessToken: new Secret(`ROW_access_${suffix}`),
    accessTokenExpiresAt: new Date(now.getTime() + 7 * DAY),
    refreshToken: new Secret(`ROW_refresh_${suffix}`),
    refreshTokenExpiresAt: new Date(now.getTime() + 60 * DAY),
    grantedScopes: ["seller.order.info", "seller.shop.info"],
    sellerName: "Ammari",
    sellerBaseRegion: "ID",
  };
}

function captureWarnings(): string[] {
  const lines: string[] = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    });
  }
  return lines;
}

function fakeAuth(options: { delayMs?: number; fail?: TikTokApiError; tokens?: Partial<TikTokTokenSet> } = {}) {
  const calls: string[] = [];
  const auth: TikTokAuthClient = {
    async getAccessToken() {
      throw new Error("not used");
    },
    async refreshAccessToken(refreshToken) {
      calls.push(refreshToken.reveal());
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.fail) throw options.fail;
      // A fresh 7-day token as of a week after NOW, so it is not due again for any clock used here.
      return { ...tokenSet(`refreshed_${calls.length}`, new Date(NOW.getTime() + 7 * DAY)), ...options.tokens };
    },
  };
  return { auth, calls };
}

async function connect(db: TestDatabase, staffUserId: string, tokens = tokenSet("1"), shop = SHOP) {
  const result = await saveTikTokConnection(db, { tokens, shop, staffUserId, keyring: KEYRING, now: NOW });
  if (!result.ok) throw new Error(`connect failed: ${result.reason}`);
  return result.connectionId;
}

async function row(db: TestDatabase, id: string) {
  const [found] = await db.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.id, id));
  return found!;
}

async function audits(db: TestDatabase, id: string) {
  return db.select().from(auditLog).where(and(eq(auditLog.entityType, "tiktok_shop_connection"), eq(auditLog.entityId, id))).orderBy(auditLog.createdAt);
}

/** Cleanup for the tests that commit for real (concurrency). */
const committed = { staff: [] as string[], connections: [] as string[] };
afterEach(async () => {
  if (committed.connections.length > 0) {
    await testDb.delete(auditLog).where(inArray(auditLog.entityId, committed.connections));
    await testDb.delete(tiktokShopConnections).where(inArray(tiktokShopConnections.id, committed.connections));
  }
  if (committed.staff.length > 0) {
    await testDb.delete(tiktokOauthStates).where(inArray(tiktokOauthStates.staffUserId, committed.staff));
    await testDb.delete(staffUsers).where(inArray(staffUsers.id, committed.staff));
  }
  committed.staff = [];
  committed.connections = [];
});

describe("OAuth state", () => {
  test("stored only as a SHA-256 hash; consumed exactly once", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const state = await createTikTokOAuthState(tx, staff.id, NOW);
      const raw = state.reveal();
      expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(String(state)).toBe("[redacted]");
      const [stored] = await tx.select().from(tiktokOauthStates).where(eq(tiktokOauthStates.staffUserId, staff.id));
      expect(stored!.stateHash).toBe(createHash("sha256").update(raw).digest("hex"));
      expect(stored!.expiresAt.getTime() - NOW.getTime()).toBe(10 * 60_000);
      expect(await consumeTikTokOAuthState(tx, raw, staff.id, NOW)).toBe(true);
      expect(await consumeTikTokOAuthState(tx, raw, staff.id, NOW)).toBe(false);
    });
  });

  test("refused for another staff user, after 10 minutes, or when malformed", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const other = await insertStaffUser(tx);
      const raw = (await createTikTokOAuthState(tx, staff.id, NOW)).reveal();
      expect(await consumeTikTokOAuthState(tx, raw, other.id, NOW)).toBe(false);
      expect(await consumeTikTokOAuthState(tx, raw, staff.id, new Date(NOW.getTime() + 10 * 60_000))).toBe(false);
      expect(await consumeTikTokOAuthState(tx, "not-a-state", staff.id, NOW)).toBe(false);
      expect(await consumeTikTokOAuthState(tx, "", staff.id, NOW)).toBe(false);
      // Still unused: the right user within the window gets it.
      expect(await consumeTikTokOAuthState(tx, raw, staff.id, new Date(NOW.getTime() + 9 * 60_000))).toBe(true);
    });
  });

  test("expired states older than a day are removed when a new connection starts", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await createTikTokOAuthState(tx, staff.id, new Date(NOW.getTime() - 3 * DAY));
      await createTikTokOAuthState(tx, staff.id, NOW);
      expect(await tx.select().from(tiktokOauthStates).where(eq(tiktokOauthStates.staffUserId, staff.id))).toHaveLength(1);
    });
  });

  test("two concurrent callbacks with the same state: exactly one wins", async () => {
    const staff = await insertStaffUser(testDb);
    committed.staff.push(staff.id);
    const raw = (await createTikTokOAuthState(testDb, staff.id)).reveal();
    const results = await Promise.all([consumeTikTokOAuthState(testDb, raw, staff.id), consumeTikTokOAuthState(testDb, raw, staff.id)]);
    expect(results.sort()).toEqual([false, true]);
  });
});

describe("connect", () => {
  test("tokens are stored encrypted with AAD (row + column), audited without any token", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const id = await connect(tx, staff.id);
      const saved = await row(tx, id);
      expect(saved.status).toBe("active");
      expect(saved.tokenGeneration).toBe(0);
      expect(saved.tokenKeyVersion).toBe(1);
      expect(saved.grantedScopes).toEqual(["seller.order.info", "seller.shop.info"]);
      expect(saved.accessTokenCt!.toString("latin1")).not.toContain("ROW_access_1");
      expect(saved.refreshTokenCt!.toString("latin1")).not.toContain("ROW_refresh_1");
      expect(decryptToken(saved.accessTokenCt!, KEYRING, { connectionId: id, column: "access_token_ct" }).reveal()).toBe("ROW_access_1");
      // Swapping the columns does not decrypt.
      expect(() => decryptToken(saved.accessTokenCt!, KEYRING, { connectionId: id, column: "refresh_token_ct" })).toThrow();
      const [entry] = await audits(tx, id);
      expect(entry!.action).toBe("tiktok_connect");
      expect(entry!.actorStaffUserId).toBe(staff.id);
      expect(JSON.stringify(entry)).not.toMatch(/ROW_access|ROW_refresh|ROW_cipher/);
    });
  });

  test("reconnecting the same shop rotates tokens, bumps the generation, clears warnings", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const id = await connect(tx, staff.id);
      await recordTikTokExpiryWarning(tx, { shopId: SHOP.shopId, at: NOW });
      expect(await connect(tx, staff.id, tokenSet("2"))).toBe(id);
      const saved = await row(tx, id);
      expect(saved.tokenGeneration).toBe(1);
      expect(saved.expiryWarningAt).toBeNull();
      expect(decryptToken(saved.accessTokenCt!, KEYRING, { connectionId: id, column: "access_token_ct" }).reveal()).toBe("ROW_access_2");
      expect((await audits(tx, id)).map((entry) => entry.action)).toEqual(["tiktok_connect", "tiktok_expiry_warning", "tiktok_reconnect"]);
    });
  });

  test("another shop is refused while one is active; a reconnect after deauthorization works", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const id = await connect(tx, staff.id);
      const other = await saveTikTokConnection(tx, { tokens: tokenSet("x"), shop: { ...SHOP, shopId: "7000000000000000002" }, staffUserId: staff.id, keyring: KEYRING, now: NOW });
      expect(other).toEqual({ ok: false, reason: "other_shop_active" });
      await deauthorizeTikTokShop(tx, { shopId: SHOP.shopId, at: NOW });
      expect(await connect(tx, staff.id, tokenSet("3"))).toBe(id);
      expect((await row(tx, id)).status).toBe("active");
      expect((await row(tx, id)).deauthorizedAt).toBeNull();
    });
  });
});

describe("token refresh", () => {
  test("more than 24 h left: no TikTok call", async () => {
    await withRollback(async (tx) => {
      const id = await connect(tx, (await insertStaffUser(tx)).id);
      const { auth, calls } = fakeAuth();
      const outcome = await refreshTikTokToken(tx, { auth, keyring: KEYRING, now: () => new Date(NOW.getTime() + 5 * DAY) });
      expect(outcome).toEqual({ kind: "not_due", tokenGeneration: 0 });
      expect(calls).toEqual([]);
      expect((await row(tx, id)).tokenGeneration).toBe(0);
    });
  });

  test("under 24 h left: one call with the decrypted refresh token, new tokens encrypted, generation + 1, audited", async () => {
    await withRollback(async (tx) => {
      const id = await connect(tx, (await insertStaffUser(tx)).id);
      const { auth, calls } = fakeAuth();
      const at = new Date(NOW.getTime() + 6.5 * DAY);
      const outcome = await refreshTikTokToken(tx, { auth, keyring: KEYRING, now: () => at });
      expect(outcome).toEqual({ kind: "refreshed", tokenGeneration: 1 });
      expect(calls).toEqual(["ROW_refresh_1"]);
      const saved = await row(tx, id);
      expect(decryptToken(saved.accessTokenCt!, KEYRING, { connectionId: id, column: "access_token_ct" }).reveal()).toBe("ROW_access_refreshed_1");
      expect(saved.lastRefreshedAt).toEqual(at);
      const refresh = (await audits(tx, id)).find((entry) => entry.action === "tiktok_token_refresh");
      expect(refresh?.actorStaffUserId).toBeNull();
      expect(JSON.stringify(refresh)).not.toMatch(/ROW_/);
    });
  });

  test("a stale seen generation: another refresher already rotated, no call", async () => {
    await withRollback(async (tx) => {
      await connect(tx, (await insertStaffUser(tx)).id);
      const { auth, calls } = fakeAuth();
      await refreshTikTokToken(tx, { auth, keyring: KEYRING, now: () => NOW }, { force: true, seenGeneration: 0 });
      const second = await refreshTikTokToken(tx, { auth, keyring: KEYRING, now: () => NOW }, { force: true, seenGeneration: 0 });
      expect(second).toEqual({ kind: "already_refreshed", tokenGeneration: 1 });
      expect(calls).toHaveLength(1);
    });
  });

  test("refresh token expired: reauth_required without calling TikTok", async () => {
    await withRollback(async (tx) => {
      const id = await connect(tx, (await insertStaffUser(tx)).id);
      const { auth, calls } = fakeAuth();
      const outcome = await refreshTikTokToken(tx, { auth, keyring: KEYRING, now: () => new Date(NOW.getTime() + 61 * DAY) });
      expect(outcome).toEqual({ kind: "reauth_required", reason: "refresh_token_expired" });
      expect(calls).toEqual([]);
      expect((await row(tx, id)).status).toBe("reauth_required");
      expect((await audits(tx, id)).map((entry) => entry.action)).toContain("tiktok_reauth_required");
    });
  });

  test("an undecryptable token (wrong key): reauth_required, never a crash loop", async () => {
    await withRollback(async (tx) => {
      const id = await connect(tx, (await insertStaffUser(tx)).id);
      const { auth, calls } = fakeAuth();
      const outcome = await refreshTikTokToken(tx, { auth, keyring: OTHER_KEYRING, now: () => NOW }, { force: true });
      expect(outcome).toEqual({ kind: "reauth_required", reason: "token_decrypt_failed" });
      expect(calls).toEqual([]);
      expect((await row(tx, id)).lastErrorCode).toBe("token_decrypt_failed");
      // The next run finds nothing active to refresh.
      expect(await refreshTikTokToken(tx, { auth, keyring: KEYRING, now: () => NOW }, { force: true })).toEqual({ kind: "not_connected" });
    });
  });

  test("a refusal while the access token is valid is retried later (status unchanged); after it expired it needs a reconnect", async () => {
    await withRollback(async (tx) => {
      const id = await connect(tx, (await insertStaffUser(tx)).id);
      const refusal = new TikTokApiError({ kind: "api", path: "/api/v2/token/refresh", httpStatus: 200, code: 36004005, requestId: "r" });
      const { auth } = fakeAuth({ fail: refusal });
      const early = await refreshTikTokToken(tx, { auth, keyring: KEYRING, now: () => new Date(NOW.getTime() + 6.5 * DAY) });
      expect(early).toEqual({ kind: "failed", errorCode: "api:36004005" });
      expect((await row(tx, id)).status).toBe("active");
      expect((await row(tx, id)).lastErrorCode).toBe("api:36004005");
      const late = await refreshTikTokToken(tx, { auth, keyring: KEYRING, now: () => new Date(NOW.getTime() + 8 * DAY) });
      expect(late).toEqual({ kind: "reauth_required", reason: "refresh_rejected" });
      expect((await row(tx, id)).status).toBe("reauth_required");
    });
  });

  test("T0: an invalid_response on refresh is retried and its detail is logged (never a value)", async () => {
    const lines = captureWarnings();
    await withRollback(async (tx) => {
      const id = await connect(tx, (await insertStaffUser(tx)).id);
      const refusal = new TikTokApiError({ kind: "invalid_response", path: "/api/v2/token/refresh", httpStatus: 200, code: 0, requestId: "req-r", detail: "expiry:access:beyond_cap:2027" });
      const { auth } = fakeAuth({ fail: refusal });
      const outcome = await refreshTikTokToken(tx, { auth, keyring: KEYRING, now: () => new Date(NOW.getTime() + 8 * DAY) });
      expect(outcome).toEqual({ kind: "failed", errorCode: "invalid_response:0" });
      expect((await row(tx, id)).status).toBe("active");
    });
    const text = lines.join("\n");
    expect(text).toContain("[tiktok-refresh] failed");
    expect(text).toContain('"detail":"expiry:access:beyond_cap:2027"');
    expect(text).toContain('"requestId":"req-r"');
    expect(text).not.toMatch(/ROW_/);
  });

  test("T0: a scope TikTok sent unusable on refresh keeps the scopes granted at connect, with a warning", async () => {
    const lines = captureWarnings();
    await withRollback(async (tx) => {
      const id = await connect(tx, (await insertStaffUser(tx)).id, { ...tokenSet("1"), grantedScopes: ["seller.finance.info", "seller.order.info", "seller.shop.info"] });
      const { auth } = fakeAuth({ tokens: { grantedScopes: ["seller.order.info"], droppedFields: ["granted_scopes", "seller_name"] } });
      expect((await refreshTikTokToken(tx, { auth, keyring: KEYRING, now: () => NOW }, { force: true })).kind).toBe("refreshed");
      expect((await row(tx, id)).grantedScopes).toEqual(["seller.finance.info", "seller.order.info", "seller.shop.info"]);
    });
    const text = lines.join("\n");
    expect(text).toContain("[tiktok-refresh] token fields dropped");
    expect(text).toContain('"droppedFields":["granted_scopes","seller_name"]');
  });

  test("a clean refresh replaces the scopes and warns about nothing", async () => {
    const lines = captureWarnings();
    await withRollback(async (tx) => {
      const id = await connect(tx, (await insertStaffUser(tx)).id);
      const { auth } = fakeAuth({ tokens: { grantedScopes: ["seller.finance.info", "seller.order.info"], droppedFields: [] } });
      await refreshTikTokToken(tx, { auth, keyring: KEYRING, now: () => NOW }, { force: true });
      expect((await row(tx, id)).grantedScopes).toEqual(["seller.finance.info", "seller.order.info"]);
    });
    expect(lines.join("\n")).not.toContain("[tiktok-refresh]");
  });

  test("TikTok unavailable is never a reauth, even after the access token expired", async () => {
    await withRollback(async (tx) => {
      const id = await connect(tx, (await insertStaffUser(tx)).id);
      const { auth } = fakeAuth({ fail: new TikTokApiError({ kind: "unavailable", path: "/api/v2/token/refresh", httpStatus: 503, code: null, requestId: null }) });
      const outcome = await refreshTikTokToken(tx, { auth, keyring: KEYRING, now: () => new Date(NOW.getTime() + 8 * DAY) });
      expect(outcome).toEqual({ kind: "failed", errorCode: "unavailable" });
      expect((await row(tx, id)).status).toBe("active");
    });
  });

  test("race: two refreshers at once → one TikTok call, one write, generation + 1", async () => {
    const staff = await insertStaffUser(testDb);
    committed.staff.push(staff.id);
    const id = await connect(testDb, staff.id);
    committed.connections.push(id);
    const { auth, calls } = fakeAuth({ delayMs: 150 });
    const at = () => new Date(NOW.getTime() + 6.5 * DAY);
    const outcomes = await Promise.all([refreshTikTokToken(testDb, { auth, keyring: KEYRING, now: at }), refreshTikTokToken(testDb, { auth, keyring: KEYRING, now: at })]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["not_due", "refreshed"]);
    expect(calls).toHaveLength(1);
    expect((await row(testDb, id)).tokenGeneration).toBe(1);
    expect((await audits(testDb, id)).filter((entry) => entry.action === "tiktok_token_refresh")).toHaveLength(1);
  });

  test("race on an auth error: two forced refreshers that saw the same generation → one TikTok call", async () => {
    const staff = await insertStaffUser(testDb);
    committed.staff.push(staff.id);
    const id = await connect(testDb, staff.id);
    committed.connections.push(id);
    const { auth, calls } = fakeAuth({ delayMs: 150 });
    const deps = { auth, keyring: KEYRING, now: () => NOW };
    const tokens = await Promise.all([tiktokAuthErrorRefresher(testDb, deps, 0, "/x")(), tiktokAuthErrorRefresher(testDb, deps, 0, "/x")()]);
    expect(calls).toHaveLength(1);
    expect(tokens.map((token) => token.reveal())).toEqual(["ROW_access_refreshed_1", "ROW_access_refreshed_1"]);
    expect((await row(testDb, id)).tokenGeneration).toBe(1);
  });
});

describe("deauthorization, expiry warning, disconnect", () => {
  test("topic 6 wipes both ciphertexts, sets deauthorized, stops credentials; a redelivery is a no-op", async () => {
    await withRollback(async (tx) => {
      const id = await connect(tx, (await insertStaffUser(tx)).id);
      const at = new Date(NOW.getTime() + DAY);
      expect(await deauthorizeTikTokShop(tx, { shopId: SHOP.shopId, at })).toBe(true);
      const saved = await row(tx, id);
      expect(saved.status).toBe("deauthorized");
      expect(saved.accessTokenCt).toBeNull();
      expect(saved.refreshTokenCt).toBeNull();
      expect(saved.deauthorizedAt).toEqual(at);
      expect(await deauthorizeTikTokShop(tx, { shopId: SHOP.shopId, at })).toBe(false);
      expect(await deauthorizeTikTokShop(tx, { shopId: "unknown-shop", at })).toBe(false);
      expect(await loadTikTokCredentials(tx, KEYRING)).toEqual({ ok: false, reason: "not_connected" });
      const actions = (await audits(tx, id)).map((entry) => [entry.action, entry.actorStaffUserId]);
      expect(actions).toEqual([
        ["tiktok_connect", expect.any(String)],
        ["tiktok_deauthorize", null],
      ]);
    });
  });

  test("topic 7 records the warning once; an older redelivery changes nothing", async () => {
    await withRollback(async (tx) => {
      const id = await connect(tx, (await insertStaffUser(tx)).id);
      const at = new Date(NOW.getTime() + DAY);
      expect(await recordTikTokExpiryWarning(tx, { shopId: SHOP.shopId, at })).toBe(true);
      expect(await recordTikTokExpiryWarning(tx, { shopId: SHOP.shopId, at })).toBe(false);
      expect(await recordTikTokExpiryWarning(tx, { shopId: SHOP.shopId, at: NOW })).toBe(false);
      expect((await row(tx, id)).expiryWarningAt).toEqual(at);
      expect((await getTikTokConnectionView(tx))?.expiryWarningAt).toEqual(at);
    });
  });

  test("Putuskan wipes the tokens and is audited with the staff user; nothing left to disconnect after", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const id = await connect(tx, staff.id);
      expect(await disconnectTikTokShop(tx, { staffUserId: staff.id })).toEqual({ ok: true, shopId: SHOP.shopId });
      const saved = await row(tx, id);
      expect(saved.status).toBe("disconnected");
      expect(saved.accessTokenCt).toBeNull();
      expect(await disconnectTikTokShop(tx, { staffUserId: staff.id })).toEqual({ ok: false, reason: "not_connected" });
      const last = (await audits(tx, id)).at(-1)!;
      expect([last.action, last.actorStaffUserId]).toEqual(["tiktok_disconnect", staff.id]);
    });
  });

  test("the view never selects a token column", async () => {
    await withRollback(async (tx) => {
      await connect(tx, (await insertStaffUser(tx)).id);
      const view = await getTikTokConnectionView(tx);
      expect(view?.shopName).toBe("Ammari");
      expect(Object.keys(view!)).not.toContain("accessTokenCt");
      expect(JSON.stringify(view)).not.toMatch(/ROW_/);
    });
  });
});

describe("no token, code or secret in any log line", () => {
  test("connect, refresh (ok and failing), deauthorize", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      });
    }
    await withRollback(async (tx) => {
      await connect(tx, (await insertStaffUser(tx)).id);
      await refreshTikTokToken(tx, { auth: fakeAuth().auth, keyring: KEYRING, now: () => NOW }, { force: true });
      const failing = fakeAuth({ fail: new TikTokApiError({ kind: "api", path: "/api/v2/token/refresh", httpStatus: 200, code: 1, requestId: null }) });
      await refreshTikTokToken(tx, { auth: failing.auth, keyring: KEYRING, now: () => NOW }, { force: true });
      await deauthorizeTikTokShop(tx, { shopId: SHOP.shopId, at: NOW });
    });
    expect(lines.join("\n")).not.toMatch(/ROW_|\[7,7,7/);
  });
});
