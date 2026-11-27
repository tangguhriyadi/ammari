import { describe, expect, test } from "vitest";
import { FAKE_TIKTOK_GOOD_CODE } from "./fake";
import { tiktokRuntimeFromEnv } from "./runtime";
import { tiktokConnectionBanner, tiktokRefreshDue } from "./status";
import { Secret } from "@ammari/tiktok-shop";

const NOW = new Date("2026-11-27T03:00:00.000Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

describe("tiktokRefreshDue (< 24 h left)", () => {
  test.each([
    [null, true],
    [at(-1), true],
    [at(0.99), true],
    [at(1), false],
    [at(6), false],
  ])("access token expiring %s → %s", (expiresAt, due) => {
    expect(tiktokRefreshDue(expiresAt, NOW)).toBe(due);
  });
});

describe("tiktokConnectionBanner", () => {
  const base = { status: "active" as const, refreshTokenExpiresAt: at(60), expiryWarningAt: null };

  test("never connected, healthy, or disconnected on purpose: no banner", () => {
    expect(tiktokConnectionBanner(null, NOW)).toBeNull();
    expect(tiktokConnectionBanner(base, NOW)).toBeNull();
    expect(tiktokConnectionBanner({ ...base, status: "disconnected" }, NOW)).toBeNull();
  });

  test("deauthorized (topic 6) and reauth_required are red", () => {
    expect(tiktokConnectionBanner({ ...base, status: "deauthorized" }, NOW)).toEqual({ kind: "deauthorized", tone: "danger" });
    expect(tiktokConnectionBanner({ ...base, status: "reauth_required" }, NOW)).toEqual({ kind: "reauth_required", tone: "danger" });
    expect(tiktokConnectionBanner({ ...base, refreshTokenExpiresAt: at(-0.1) }, NOW)).toEqual({ kind: "reauth_required", tone: "danger" });
  });

  test("refresh token within 7 days, or topic 7 received: reconnect before the deadline", () => {
    expect(tiktokConnectionBanner({ ...base, refreshTokenExpiresAt: at(7) }, NOW)).toEqual({ kind: "expiring", tone: "warning", deadline: at(7) });
    expect(tiktokConnectionBanner({ ...base, refreshTokenExpiresAt: at(7.01) }, NOW)).toBeNull();
    expect(tiktokConnectionBanner({ ...base, expiryWarningAt: NOW }, NOW)).toEqual({ kind: "expiring", tone: "warning", deadline: at(60) });
  });
});

describe("tiktokRuntimeFromEnv", () => {
  const real = {
    TIKTOK_APP_KEY: "dummyappkey",
    TIKTOK_APP_SECRET: "dummyappsecret",
    TIKTOK_SERVICE_ID: "7000000000000000999",
    TIKTOK_TOKEN_ENC_KEY_V1: Buffer.alloc(32, 3).toString("base64"),
    TIKTOK_TOKEN_ENC_KEY_CURRENT: "1",
  };

  test("off unless configured; problems name variables, never values", () => {
    const result = tiktokRuntimeFromEnv({ TIKTOK_APP_SECRET: "s3cr3tvalue" }, { requireServiceId: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContain("TIKTOK_APP_KEY is not set");
    expect(result.problems).toContain("TIKTOK_SERVICE_ID is not set");
    expect(result.problems.join(" ")).not.toContain("s3cr3tvalue");
  });

  test("configured from the environment", () => {
    const result = tiktokRuntimeFromEnv(real, { requireServiceId: true });
    expect(result.ok && result.runtime.config.serviceId).toBe("7000000000000000999");
  });

  test("the fake only in a non-production build with E2E_TEST_LOGIN=true", () => {
    expect(tiktokRuntimeFromEnv({ TIKTOK_PROVIDER: "fake" }).ok).toBe(false);
    expect(tiktokRuntimeFromEnv({ TIKTOK_PROVIDER: "fake", E2E_TEST_LOGIN: "true", NODE_ENV: "production" }).ok).toBe(false);
    // An unset NODE_ENV is never taken as non-production.
    expect(tiktokRuntimeFromEnv({ TIKTOK_PROVIDER: "fake", E2E_TEST_LOGIN: "true" }).ok).toBe(false);
    expect(tiktokRuntimeFromEnv({ ...real, TIKTOK_PROVIDER: "other" }).ok).toBe(false);
    expect(tiktokRuntimeFromEnv({ TIKTOK_PROVIDER: "fake", E2E_TEST_LOGIN: "true", NODE_ENV: "development" }, { requireServiceId: true }).ok).toBe(true);
  });

  test("the fake answers token get for the e2e code only, without any network", async () => {
    const result = tiktokRuntimeFromEnv({ TIKTOK_PROVIDER: "fake", E2E_TEST_LOGIN: "true", NODE_ENV: "test" });
    if (!result.ok) throw new Error("expected the fake runtime");
    const tokens = await result.runtime.auth.getAccessToken(new Secret(FAKE_TIKTOK_GOOD_CODE));
    expect(tokens.accessToken.reveal()).toMatch(/^ROW_fake_access_/);
    await expect(result.runtime.auth.getAccessToken(new Secret("used"))).rejects.toMatchObject({ kind: "api" });
  });
});
