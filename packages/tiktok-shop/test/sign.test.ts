import { describe, expect, test } from "vitest";
import { buildStringToSign, signRequest } from "../src/sign";
import { vectors, type SignVector } from "./fixtures";

function input(vector: SignVector, query = vector.query) {
  return { appSecret: vector.app_secret, path: vector.path, query, body: vector.body ?? undefined };
}

describe("official TikTok API sign vector", () => {
  const vector = vectors.official.api_sign;

  test("the fixture holds exactly the values recorded in the plan", () => {
    expect(vector).toMatchObject({
      app_secret: "e59af819cc",
      method: "GET",
      path: "/authorization/202309/shops",
      query: { app_key: "29a39d", timestamp: "1623812664" },
      string_to_sign: "e59af819cc/authorization/202309/shopsapp_key29a39dtimestamp1623812664e59af819cc",
      sign: "b596b73e0cc6de07ac26f036364178ab16b0a907af13d43f0a0cd2345f582dc8",
    });
  });

  test("builds TikTok's string to sign", () => {
    expect(buildStringToSign(input(vector))).toBe(vector.string_to_sign);
  });

  test("produces TikTok's published hex", () => {
    expect(signRequest(input(vector))).toBe(vector.sign);
  });

  test("sign and access_token in the query do not change the signature", () => {
    const query = { ...vector.query, sign: "0123abcd", access_token: "ROW_dummy_access_token" };
    expect(buildStringToSign(input(vector, query))).toBe(vector.string_to_sign);
    expect(signRequest(input(vector, query))).toBe(vector.sign);
  });

  test("an empty body and no body sign the same (GET)", () => {
    expect(signRequest({ ...input(vector), body: "" })).toBe(vector.sign);
  });
});

describe("own sign vectors (derived with openssl, see the fixture)", () => {
  for (const vector of vectors.own.api_sign) {
    test(`${vector.name}: string to sign and hex`, () => {
      expect(buildStringToSign(input(vector))).toBe(vector.string_to_sign);
      expect(signRequest(input(vector))).toBe(vector.sign);
    });
  }

  const post = vectors.own.api_sign.find((vector) => vector.name === "post_body")!;

  test("the body is signed byte for byte: reformatting the same JSON changes the signature", () => {
    const reformatted = JSON.stringify(JSON.parse(post.body!));
    expect(reformatted).not.toBe(post.body);
    expect(signRequest({ ...input(post), body: reformatted })).not.toBe(post.sign);
  });

  test("a body request differs from the same request without its body", () => {
    expect(signRequest({ ...input(post), body: undefined })).not.toBe(post.sign);
  });

  test("params are sorted by key whatever order they arrive in", () => {
    const reversed = Object.fromEntries(Object.entries(post.query).reverse());
    expect(Object.keys(reversed)).not.toEqual(Object.keys(post.query));
    expect(signRequest(input(post, reversed))).toBe(post.sign);
  });

  test("an empty value contributes its key only", () => {
    const vector = vectors.own.api_sign.find((v) => v.name === "unsorted_empty")!;
    expect(vector.query.shop_cipher).toBe("");
    expect(buildStringToSign(input(vector))).toContain("page_tokenab+c/d==shop_ciphertimestamp");
  });

  test("page_token is signed raw, not URL-encoded", () => {
    const vector = vectors.own.api_sign.find((v) => v.name === "unsorted_empty")!;
    expect(buildStringToSign(input(vector))).toContain("page_tokenab+c/d==");
    expect(buildStringToSign(input(vector))).not.toContain("%2B");
  });

  test("sorting is by code unit, not locale: uppercase before lowercase", () => {
    expect(buildStringToSign({ appSecret: "s", path: "/p", query: { b: "1", a: "2", B: "3", _: "4" } })).toBe("s/pB3_4a2b1s");
  });

  test("an empty app secret is refused (an empty HMAC key is forgeable)", () => {
    expect(() => signRequest({ appSecret: "", path: "/p", query: {} })).toThrow("app secret is empty");
  });

  test("a path with a query string is refused", () => {
    expect(() => signRequest({ appSecret: "s", path: "/p?x=1", query: {} })).toThrow();
    expect(() => signRequest({ appSecret: "s", path: "p", query: {} })).toThrow();
  });
});
