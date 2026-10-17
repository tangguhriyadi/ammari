// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clearRememberedOtpSendAttempt, getRememberedOtpSendAttempt, rememberOtpSendAttempt } from "../src/lib/otp-send-guard";

const PREFIX = "test-otp-last-send";
const OTP_EXPIRES_MS = 5 * 60 * 1000;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rememberOtpSendAttempt / getRememberedOtpSendAttempt", () => {
  test("a remembered attempt is returned within maxAgeMs", async () => {
    const now = Date.now();
    await rememberOtpSendAttempt(PREFIX, "owner@ammari.id", now);
    const result = await getRememberedOtpSendAttempt(PREFIX, "owner@ammari.id", OTP_EXPIRES_MS);
    expect(result).toBe(now);
  });

  test("email is matched case-insensitively and trimmed", async () => {
    const now = Date.now();
    await rememberOtpSendAttempt(PREFIX, "  Owner@Ammari.ID  ", now);
    const result = await getRememberedOtpSendAttempt(PREFIX, "owner@ammari.id", OTP_EXPIRES_MS);
    expect(result).toBe(now);
  });

  test("returns null for an email that never sent anything", async () => {
    const result = await getRememberedOtpSendAttempt(PREFIX, "nobody@ammari.id", OTP_EXPIRES_MS);
    expect(result).toBeNull();
  });

  test("returns null once the attempt is older than maxAgeMs", async () => {
    const now = Date.now();
    await rememberOtpSendAttempt(PREFIX, "owner@ammari.id", now - OTP_EXPIRES_MS - 1000);
    const result = await getRememberedOtpSendAttempt(PREFIX, "owner@ammari.id", OTP_EXPIRES_MS);
    expect(result).toBeNull();
  });

  test("a second remembered email does not collide with the first", async () => {
    const now = Date.now();
    await rememberOtpSendAttempt(PREFIX, "a@ammari.id", now);
    await rememberOtpSendAttempt(PREFIX, "b@ammari.id", now - 10_000);
    expect(await getRememberedOtpSendAttempt(PREFIX, "a@ammari.id", OTP_EXPIRES_MS)).toBe(now);
    expect(await getRememberedOtpSendAttempt(PREFIX, "b@ammari.id", OTP_EXPIRES_MS)).toBe(now - 10_000);
  });

  test("a different storageKeyPrefix (a different app) never sees another app's remembered attempt", async () => {
    const now = Date.now();
    await rememberOtpSendAttempt("app-a-otp", "owner@ammari.id", now);
    expect(await getRememberedOtpSendAttempt("app-b-otp", "owner@ammari.id", OTP_EXPIRES_MS)).toBeNull();
  });

  test("the raw localStorage value never contains the plaintext email", async () => {
    const now = Date.now();
    await rememberOtpSendAttempt(PREFIX, "owner@ammari.id", now);
    const allValues = Object.keys(localStorage).map((key) => `${key}:${localStorage.getItem(key)}`);
    for (const entry of allValues) {
      expect(entry.toLowerCase()).not.toContain("owner@ammari.id");
    }
  });

  test("a localStorage failure (e.g. private mode) is swallowed, not thrown", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    await expect(rememberOtpSendAttempt(PREFIX, "owner@ammari.id", Date.now())).resolves.toBeUndefined();
  });

  test("a localStorage read failure resolves to null instead of throwing", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    await expect(getRememberedOtpSendAttempt(PREFIX, "owner@ammari.id", OTP_EXPIRES_MS)).resolves.toBeNull();
  });
});

describe("clearRememberedOtpSendAttempt", () => {
  test("removes a previously remembered attempt for that email", async () => {
    const now = Date.now();
    await rememberOtpSendAttempt(PREFIX, "owner@ammari.id", now);
    await clearRememberedOtpSendAttempt(PREFIX, "owner@ammari.id");
    expect(await getRememberedOtpSendAttempt(PREFIX, "owner@ammari.id", OTP_EXPIRES_MS)).toBeNull();
  });

  test("does not affect a different email's remembered attempt", async () => {
    const now = Date.now();
    await rememberOtpSendAttempt(PREFIX, "a@ammari.id", now);
    await rememberOtpSendAttempt(PREFIX, "b@ammari.id", now);
    await clearRememberedOtpSendAttempt(PREFIX, "a@ammari.id");
    expect(await getRememberedOtpSendAttempt(PREFIX, "a@ammari.id", OTP_EXPIRES_MS)).toBeNull();
    expect(await getRememberedOtpSendAttempt(PREFIX, "b@ammari.id", OTP_EXPIRES_MS)).toBe(now);
  });

  test("clearing an email with no remembered attempt is a harmless no-op", async () => {
    await expect(clearRememberedOtpSendAttempt(PREFIX, "nobody@ammari.id")).resolves.toBeUndefined();
  });

  test("a localStorage failure is swallowed, not thrown", async () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    await expect(clearRememberedOtpSendAttempt(PREFIX, "owner@ammari.id")).resolves.toBeUndefined();
  });
});
