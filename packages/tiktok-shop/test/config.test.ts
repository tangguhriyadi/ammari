import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, test } from "vitest";
import { tiktokConfigFromEnv } from "../src/config";
import { Secret } from "../src/secret";

// Dummy values only; never the owner's ~/ammari-secrets files.
const KEY_V1 = randomBytes(32).toString("base64");
const KEY_V2 = randomBytes(32).toString("base64");
const base = {
  TIKTOK_APP_KEY: "dummyappkey",
  TIKTOK_APP_SECRET: "dummyappsecret0123456789",
  TIKTOK_TOKEN_ENC_KEY_V1: KEY_V1,
  TIKTOK_TOKEN_ENC_KEY_CURRENT: "1",
};

describe("Secret redaction (§7.1)", () => {
  const secret = new Secret("dummy-secret-value");

  test("JSON.stringify, inspect, template strings, String() and concatenation show [redacted]", () => {
    expect(JSON.stringify(secret)).toBe('"[redacted]"');
    expect(JSON.stringify({ nested: { secret } })).toBe('{"nested":{"secret":"[redacted]"}}');
    expect(inspect(secret)).toBe("[redacted]");
    expect(inspect({ nested: { secret } }, { depth: 5 })).not.toContain("dummy-secret-value");
    expect(`${secret}`).toBe("[redacted]");
    expect(String(secret)).toBe("[redacted]");
    expect("x" + secret).toBe("x[redacted]");
    expect(Object.keys(secret)).toEqual([]);
  });

  test("reveal() is the only way to the value", () => {
    expect(secret.reveal()).toBe("dummy-secret-value");
  });

  test("a byte secret is redacted too", () => {
    const bytes = new Secret(new Uint8Array([1, 2, 3]));
    expect(inspect(bytes)).toBe("[redacted]");
    expect(JSON.stringify(bytes)).toBe('"[redacted]"');
  });
});

describe("tiktokConfigFromEnv", () => {
  test("a complete env is configured", () => {
    const result = tiktokConfigFromEnv(base);
    expect(result.configured).toBe(true);
    if (!result.configured) return;
    expect(result.config.appKey.reveal()).toBe("dummyappkey");
    expect(result.config.appSecret.reveal()).toBe(base.TIKTOK_APP_SECRET);
    expect(result.config.serviceId).toBeNull();
    expect(result.config.tokenKeyring.currentVersion).toBe(1);
    expect(Buffer.from(result.config.tokenKeyring.keys.get(1)!.reveal()).toString("base64")).toBe(KEY_V1);
  });

  test("the config object prints no secret", () => {
    const result = tiktokConfigFromEnv(base);
    const text = `${JSON.stringify(result)} ${inspect(result, { depth: 10 })}`;
    expect(text).not.toContain(base.TIKTOK_APP_SECRET);
    expect(text).not.toContain(base.TIKTOK_APP_KEY);
    expect(text).not.toContain(KEY_V1);
  });

  test("an empty env is not configured, and problems name variables only", () => {
    const result = tiktokConfigFromEnv({});
    expect(result).toEqual({
      configured: false,
      problems: ["TIKTOK_APP_KEY is not set", "TIKTOK_APP_SECRET is not set", "TIKTOK_TOKEN_ENC_KEY_CURRENT is not set"],
    });
  });

  test("bad values are reported without echoing them", () => {
    const env = { ...base, TIKTOK_APP_SECRET: "has space", TIKTOK_TOKEN_ENC_KEY_V1: "dG9vc2hvcnQ=" };
    const result = tiktokConfigFromEnv(env);
    expect(result.configured).toBe(false);
    if (result.configured) return;
    expect(result.problems).toEqual(["TIKTOK_APP_SECRET has an invalid format", "TIKTOK_TOKEN_ENC_KEY_V1 must be 32 random bytes in base64"]);
    expect(result.problems.join(" ")).not.toContain("has space");
    expect(result.problems.join(" ")).not.toContain("dG9vc2hvcnQ=");
  });

  test.each([
    ["a quoted value", '"dummyappkey"'],
    ["trailing newline", "dummyappkey\n"],
    ["leading space", " dummyappkey"],
  ])("app key with %s is refused", (_label, value) => {
    expect(tiktokConfigFromEnv({ ...base, TIKTOK_APP_KEY: value }).configured).toBe(false);
  });

  test("the encryption key must be exactly 32 bytes of canonical base64", () => {
    for (const value of [randomBytes(31).toString("base64"), randomBytes(33).toString("base64"), KEY_V1.replace("=", ""), `${KEY_V1.slice(0, 42)}!=`]) {
      expect(tiktokConfigFromEnv({ ...base, TIKTOK_TOKEN_ENC_KEY_V1: value }).configured).toBe(false);
    }
  });

  test("CURRENT must name a configured key version", () => {
    const result = tiktokConfigFromEnv({ ...base, TIKTOK_TOKEN_ENC_KEY_CURRENT: "2" });
    expect(result).toEqual({ configured: false, problems: ["TIKTOK_TOKEN_ENC_KEY_V2 is not set (named by TIKTOK_TOKEN_ENC_KEY_CURRENT)"] });
    for (const value of ["0", "01", "x", "256", "1.0"]) {
      expect(tiktokConfigFromEnv({ ...base, TIKTOK_TOKEN_ENC_KEY_CURRENT: value }).configured).toBe(false);
    }
  });

  test("rotation: V1 and V2 both load, V2 current", () => {
    const result = tiktokConfigFromEnv({ ...base, TIKTOK_TOKEN_ENC_KEY_V2: KEY_V2, TIKTOK_TOKEN_ENC_KEY_CURRENT: "2" });
    expect(result.configured).toBe(true);
    if (!result.configured) return;
    expect([...result.config.tokenKeyring.keys.keys()].sort()).toEqual([1, 2]);
    expect(result.config.tokenKeyring.currentVersion).toBe(2);
  });

  test("an invalid old key is a problem too (it could never decrypt)", () => {
    expect(tiktokConfigFromEnv({ ...base, TIKTOK_TOKEN_ENC_KEY_V2: "bad" }).configured).toBe(false);
  });

  test("TIKTOK_SERVICE_ID: required on request, numeric, never the App Key (Q4)", () => {
    expect(tiktokConfigFromEnv(base, { requireServiceId: true })).toEqual({ configured: false, problems: ["TIKTOK_SERVICE_ID is not set"] });
    const ok = tiktokConfigFromEnv({ ...base, TIKTOK_SERVICE_ID: "7712559784284669716" }, { requireServiceId: true });
    expect(ok.configured && ok.config.serviceId).toBe("7712559784284669716");
    expect(tiktokConfigFromEnv({ ...base, TIKTOK_SERVICE_ID: "abc" }).configured).toBe(false);
    expect(tiktokConfigFromEnv({ ...base, TIKTOK_APP_KEY: "12345", TIKTOK_SERVICE_ID: "12345" }).configured).toBe(false);
  });
});
