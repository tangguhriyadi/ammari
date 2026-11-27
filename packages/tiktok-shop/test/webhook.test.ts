import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { computeWebhookSignature, verifyWebhookSignature } from "../src/webhook";
import { officialWebhookBody, vectors } from "./fixtures";

describe("official TikTok webhook vector", () => {
  const vector = vectors.official.webhook;

  test("the fixture holds exactly the values recorded in the plan", () => {
    expect(vector).toMatchObject({
      app_key: "abcdef",
      app_secret: "123",
      authorization: "5dec0f11ec2f6783b8deee53c9ffbf8d024302f7c7e7fa55a35d17629031ac05",
      body_file: "official-webhook-body.json",
      body_length: 223,
      body_sha256: "3007a31e74e55c2825a5868a29f4ae001fc63a298d429dc3dbfa2a7aa908e492",
    });
  });

  // The body file must stay byte-exact: an editor reformatting it (or adding a newline) changes
  // its length and hash, and this test fails before the signature check is even reached.
  test("the byte-exact body file is intact (length + SHA-256) and verifies", () => {
    const body = officialWebhookBody;
    expect(body.length).toBe(vector.body_length);
    expect(createHash("sha256").update(body).digest("hex")).toBe(vector.body_sha256);
    expect(body.at(-1)).not.toBe(0x0a);
    expect(computeWebhookSignature(vector.app_key, vector.app_secret, body).toString("hex")).toBe(vector.authorization);
    expect(verifyWebhookSignature({ appKey: vector.app_key, appSecret: vector.app_secret, rawBody: body, authorization: vector.authorization })).toBe(true);
  });
});

describe("verifyWebhookSignature (own vector, derived with openssl)", () => {
  const vector = vectors.own.webhook;
  const body = Buffer.from(vector.body, "utf8");
  const verify = (rawBody: Uint8Array | string, authorization: string | null | undefined) =>
    verifyWebhookSignature({ appKey: vector.app_key, appSecret: vector.app_secret, rawBody, authorization });

  test("the openssl-derived signature verifies, as bytes and as a string", () => {
    expect(computeWebhookSignature(vector.app_key, vector.app_secret, body).toString("hex")).toBe(vector.authorization);
    expect(verify(body, vector.authorization)).toBe(true);
    expect(verify(vector.body, vector.authorization)).toBe(true);
  });

  test("one changed body byte is refused", () => {
    for (const index of [0, Math.floor(body.length / 2), body.length - 1]) {
      const tampered = Buffer.from(body);
      tampered[index] = tampered[index]! ^ 0x01;
      expect(verify(tampered, vector.authorization)).toBe(false);
    }
  });

  test("a re-serialized body (same JSON, other bytes) is refused", () => {
    expect(verify(JSON.stringify(JSON.parse(vector.body), null, 1), vector.authorization)).toBe(false);
  });

  test("one changed signature character is refused", () => {
    const last = vector.authorization.at(-1) === "0" ? "1" : "0";
    expect(verify(body, `${vector.authorization.slice(0, -1)}${last}`)).toBe(false);
  });

  test("uppercase hex is refused even though it encodes the same bytes", () => {
    expect(verify(body, vector.authorization.toUpperCase())).toBe(false);
  });

  test("wrong length, prefixes, whitespace and a missing header are refused", () => {
    for (const header of [
      vector.authorization.slice(0, 63),
      `${vector.authorization}0`,
      `${vector.authorization}00`,
      `Bearer ${vector.authorization}`,
      ` ${vector.authorization}`,
      `${vector.authorization}\n`,
      "",
      null,
      undefined,
    ]) {
      expect(verify(body, header)).toBe(false);
    }
  });

  test("an empty app key or secret never verifies, even with a matching signature", () => {
    const forged = computeWebhookSignature("", "", body).toString("hex");
    expect(verifyWebhookSignature({ appKey: "", appSecret: "", rawBody: body, authorization: forged })).toBe(false);
    const emptySecret = computeWebhookSignature(vector.app_key, "", body).toString("hex");
    expect(verifyWebhookSignature({ appKey: vector.app_key, appSecret: "", rawBody: body, authorization: emptySecret })).toBe(false);
  });

  test("a different app key or secret is refused", () => {
    expect(verifyWebhookSignature({ appKey: "other", appSecret: vector.app_secret, rawBody: body, authorization: vector.authorization })).toBe(false);
    expect(verifyWebhookSignature({ appKey: vector.app_key, appSecret: "other", rawBody: body, authorization: vector.authorization })).toBe(false);
  });

  test("the comparison is constant-time (crypto.timingSafeEqual)", async () => {
    vi.resetModules();
    const calls: number[] = [];
    vi.doMock("node:crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:crypto")>();
      return {
        ...actual,
        timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
          calls.push(a.byteLength);
          return actual.timingSafeEqual(a, b);
        },
      };
    });
    const { verifyWebhookSignature: verifyMocked } = await import("../src/webhook");
    expect(verifyMocked({ appKey: vector.app_key, appSecret: vector.app_secret, rawBody: body, authorization: vector.authorization })).toBe(true);
    expect(verifyMocked({ appKey: vector.app_key, appSecret: vector.app_secret, rawBody: body, authorization: "0".repeat(64) })).toBe(false);
    expect(calls).toEqual([32, 32]);
    vi.doUnmock("node:crypto");
    vi.resetModules();
  });

});
