import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { Secret } from "../src/secret";
import { TokenDecryptError, decryptToken, encryptToken, tokenKeyVersion, type TokenAad, type TokenKeyring } from "../src/token-crypto";

// Dummy keys generated per run; never a real TIKTOK_TOKEN_ENC_KEY_*.
const key1 = new Secret(new Uint8Array(randomBytes(32)));
const key2 = new Secret(new Uint8Array(randomBytes(32)));
const ring1: TokenKeyring = { currentVersion: 1, keys: new Map([[1, key1]]) };
const ring12: TokenKeyring = { currentVersion: 2, keys: new Map([[1, key1], [2, key2]]) };
const aad: TokenAad = { connectionId: "0b7f9a52-6f43-4d2c-9c1e-6d1b3f2a9e10", column: "access_token_ct" };
const token = new Secret("ROW_dummy_access_token_ABC123");

function failure(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TokenDecryptError);
    return (error as TokenDecryptError).reason;
  }
  throw new Error("expected a TokenDecryptError");
}

describe("token encryption (AES-256-GCM, §7.2)", () => {
  test("round trip", () => {
    const stored = encryptToken(token, ring1, aad);
    expect(decryptToken(stored, ring1, aad).reveal()).toBe(token.reveal());
  });

  test("layout is version | 12-byte iv | ciphertext | 16-byte tag, and the plaintext is not in it", () => {
    const stored = encryptToken(token, ring1, aad);
    expect(stored[0]).toBe(1);
    expect(stored.length).toBe(1 + 12 + Buffer.byteLength(token.reveal()) + 16);
    expect(stored.includes(Buffer.from(token.reveal()))).toBe(false);
    expect(tokenKeyVersion(stored)).toBe(1);
  });

  test("a fresh IV every time: the same token encrypts differently", () => {
    const a = encryptToken(token, ring1, aad);
    const b = encryptToken(token, ring1, aad);
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
  });

  test("tampering with any byte fails closed", () => {
    const stored = encryptToken(token, ring1, aad);
    for (let index = 1; index < stored.length; index += 1) {
      const tampered = Buffer.from(stored);
      tampered[index] = tampered[index]! ^ 0x01;
      expect(failure(() => decryptToken(tampered, ring1, aad))).toBe("authentication_failed");
    }
  });

  test("truncation fails closed", () => {
    const stored = encryptToken(token, ring1, aad);
    expect(failure(() => decryptToken(stored.subarray(0, stored.length - 1), ring1, aad))).toBe("authentication_failed");
    expect(failure(() => decryptToken(stored.subarray(0, 20), ring1, aad))).toBe("malformed");
    expect(failure(() => decryptToken(Buffer.alloc(0), ring1, aad))).toBe("malformed");
  });

  test("AAD swap fails: another column of the same row", () => {
    const stored = encryptToken(token, ring1, aad);
    expect(failure(() => decryptToken(stored, ring1, { ...aad, column: "refresh_token_ct" }))).toBe("authentication_failed");
  });

  test("AAD swap fails: the same column of another row", () => {
    const stored = encryptToken(token, ring1, aad);
    expect(failure(() => decryptToken(stored, ring1, { ...aad, connectionId: "5c1d2e3f-0000-4000-8000-000000000001" }))).toBe("authentication_failed");
  });

  test("wrong key version: the version byte names a key that is not configured", () => {
    const stored = encryptToken(token, ring12, aad);
    expect(stored[0]).toBe(2);
    expect(failure(() => decryptToken(stored, ring1, aad))).toBe("unknown_key_version");
  });

  test("relabelling the version byte fails (it is part of the AAD and selects another key)", () => {
    const stored = encryptToken(token, ring12, aad);
    const relabelled = Buffer.from(stored);
    relabelled[0] = 1;
    expect(failure(() => decryptToken(relabelled, ring12, aad))).toBe("authentication_failed");
  });

  test("the right version number but the wrong key fails", () => {
    const stored = encryptToken(token, ring1, aad);
    const otherKey: TokenKeyring = { currentVersion: 1, keys: new Map([[1, key2]]) };
    expect(failure(() => decryptToken(stored, otherKey, aad))).toBe("authentication_failed");
  });

  test("rotation: values under the old key still decrypt while V1 is kept, new ones use V2", () => {
    const old = encryptToken(token, ring1, aad);
    expect(decryptToken(old, ring12, aad).reveal()).toBe(token.reveal());
    expect(tokenKeyVersion(encryptToken(token, ring12, aad))).toBe(2);
  });

  test("version byte 0 is malformed", () => {
    const stored = Buffer.from(encryptToken(token, ring1, aad));
    stored[0] = 0;
    expect(failure(() => decryptToken(stored, ring1, aad))).toBe("malformed");
  });

  test("encrypt refuses an empty token (it could never be decrypted)", () => {
    expect(() => encryptToken(new Secret(""), ring1, aad)).toThrow("empty token");
  });

  test("encrypt refuses a keyring without a valid current key", () => {
    expect(() => encryptToken(token, { currentVersion: 3, keys: ring12.keys }, aad)).toThrow();
    expect(() => encryptToken(token, { currentVersion: 1, keys: new Map([[1, new Secret(new Uint8Array(16))]]) }, aad)).toThrow();
  });

  test("the decrypt error carries no key or token material", () => {
    const stored = encryptToken(token, ring1, aad);
    const tampered = Buffer.from(stored);
    tampered[20] = tampered[20]! ^ 0xff;
    try {
      decryptToken(tampered, ring1, aad);
    } catch (error) {
      const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack}`;
      expect(text).not.toContain(token.reveal());
      expect(text).not.toContain(Buffer.from(key1.reveal()).toString("base64"));
    }
  });
});
