import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateHomepagePreviewToken } from "./preview-token";

describe("generateHomepagePreviewToken", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.PREVIEW_SECRET;
    process.env.PREVIEW_SECRET = "test-preview-secret";
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.PREVIEW_SECRET;
    else process.env.PREVIEW_SECRET = savedSecret;
  });

  test("is well-formed: <digits>.<hex>", () => {
    expect(generateHomepagePreviewToken()).toMatch(/^\d+\.[0-9a-f]+$/);
  });

  test("the expiry encodes roughly 15 minutes from `now`", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const token = generateHomepagePreviewToken(now);
    const [expiresAt] = token.split(".");
    expect(Number(expiresAt)).toBe(Math.floor(now.getTime() / 1000) + 15 * 60);
  });

  test("the same input (secret, now) always produces the same token — deterministic HMAC", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(generateHomepagePreviewToken(now)).toBe(generateHomepagePreviewToken(now));
  });

  test("a different secret produces a different signature for the same expiry", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const tokenA = generateHomepagePreviewToken(now);
    process.env.PREVIEW_SECRET = "a-different-secret";
    const tokenB = generateHomepagePreviewToken(now);
    expect(tokenA).not.toBe(tokenB);
    expect(tokenA.split(".")[0]).toBe(tokenB.split(".")[0]); // same expiry, different mac
  });

  test("throws when PREVIEW_SECRET is unset", () => {
    delete process.env.PREVIEW_SECRET;
    expect(() => generateHomepagePreviewToken()).toThrow(/PREVIEW_SECRET is not set/);
  });
});
