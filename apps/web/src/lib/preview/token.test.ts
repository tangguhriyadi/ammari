import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateHomepagePreviewToken, verifyHomepagePreviewToken } from "./token";

describe("generateHomepagePreviewToken / verifyHomepagePreviewToken", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.PREVIEW_SECRET;
    process.env.PREVIEW_SECRET = "test-preview-secret";
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.PREVIEW_SECRET;
    else process.env.PREVIEW_SECRET = savedSecret;
  });

  test("a freshly minted token verifies", () => {
    const token = generateHomepagePreviewToken();
    expect(verifyHomepagePreviewToken(token)).toBe(true);
  });

  test("is well-formed: <digits>.<hex>", () => {
    const token = generateHomepagePreviewToken();
    expect(token).toMatch(/^\d+\.[0-9a-f]+$/);
  });

  test("an expired token is rejected", () => {
    const token = generateHomepagePreviewToken({ ttlSeconds: -10 });
    expect(verifyHomepagePreviewToken(token)).toBe(false);
  });

  test("a token right at the expiry boundary (now === expiresAt) still verifies", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const token = generateHomepagePreviewToken({ ttlSeconds: 60, now });
    expect(verifyHomepagePreviewToken(token, new Date(now.getTime() + 60_000))).toBe(true);
    expect(verifyHomepagePreviewToken(token, new Date(now.getTime() + 61_000))).toBe(false);
  });

  test("a tampered signature is rejected", () => {
    const token = generateHomepagePreviewToken();
    const [expiresAt, mac] = token.split(".");
    const flippedLastChar = mac!.slice(0, -1) + (mac!.at(-1) === "0" ? "1" : "0");
    expect(verifyHomepagePreviewToken(`${expiresAt}.${flippedLastChar}`)).toBe(false);
  });

  test("a tampered expiry (pushed into the future) is rejected — the signature no longer matches", () => {
    const token = generateHomepagePreviewToken({ ttlSeconds: -10 }); // already-expired token
    const [expiresAt, mac] = token.split(".");
    const pushedOut = Number(expiresAt) + 10_000;
    expect(verifyHomepagePreviewToken(`${pushedOut}.${mac}`)).toBe(false);
  });

  test("a token signed with a different secret is rejected", () => {
    const token = generateHomepagePreviewToken();
    process.env.PREVIEW_SECRET = "a-completely-different-secret";
    expect(verifyHomepagePreviewToken(token)).toBe(false);
  });

  test("malformed tokens are rejected without throwing", () => {
    expect(verifyHomepagePreviewToken("")).toBe(false);
    expect(verifyHomepagePreviewToken("not-a-token")).toBe(false);
    expect(verifyHomepagePreviewToken("123")).toBe(false);
    expect(verifyHomepagePreviewToken("123.456.789")).toBe(false);
    expect(verifyHomepagePreviewToken("abc.def")).toBe(false);
    expect(verifyHomepagePreviewToken("123.not-hex")).toBe(false);
    expect(verifyHomepagePreviewToken("123.")).toBe(false);
    expect(verifyHomepagePreviewToken(".abc")).toBe(false);
  });

  test("a mac of the wrong length (but valid hex) is rejected, not thrown", () => {
    const token = generateHomepagePreviewToken();
    const [expiresAt] = token.split(".");
    expect(verifyHomepagePreviewToken(`${expiresAt}.ab`)).toBe(false);
  });
});
