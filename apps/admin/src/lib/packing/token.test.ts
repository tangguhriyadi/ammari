import { describe, expect, test } from "vitest";
import { generateClaimToken, hashClaimToken, formatClaimTokenForDisplay, claimUrl, claimUrlHost } from "./token";
import { getMainSiteUrl, getMainSiteHost } from "@/lib/main-site-url";

describe("generateClaimToken", () => {
  test("is 26 characters, Crockford Base32 alphabet only", () => {
    const token = generateClaimToken();
    expect(token).toHaveLength(26);
    expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  test("never contains the ambiguous-letter exclusions (I/L/O/U)", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateClaimToken()).not.toMatch(/[ILOU]/);
    }
  });

  test("two calls never collide (128 bits of randomness)", () => {
    const a = generateClaimToken();
    const b = generateClaimToken();
    expect(a).not.toBe(b);
  });
});

describe("hashClaimToken", () => {
  test("is deterministic for the same string", () => {
    const token = generateClaimToken();
    expect(hashClaimToken(token)).toBe(hashClaimToken(token));
  });

  test("differs for different tokens", () => {
    expect(hashClaimToken("AAAA")).not.toBe(hashClaimToken("BBBB"));
  });

  test("is a 64-character hex sha256 digest", () => {
    expect(hashClaimToken("hello")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("formatClaimTokenForDisplay", () => {
  test("groups a 26-character token into dash-separated blocks of 4", () => {
    const token = "0123456789ABCDEFGHJKMNPQRS"; // 26 chars
    expect(formatClaimTokenForDisplay(token)).toBe("0123-4567-89AB-CDEF-GHJK-MNPQ-RS");
  });

  test("the formatted form, with dashes stripped, is exactly the original token", () => {
    const token = generateClaimToken();
    expect(formatClaimTokenForDisplay(token).replace(/-/g, "")).toBe(token);
  });
});

describe("claimUrl", () => {
  test("builds the full, absolute URL from getMainSiteUrl() — never a hardcoded domain", () => {
    const url = claimUrl("0123456789ABCDEFGHJKMNPQRS");
    expect(url).toBe(`${getMainSiteUrl()}/claim/0123456789ABCDEFGHJKMNPQRS`);
  });
});

describe("claimUrlHost", () => {
  test("formats as <host>/claim, with no token and no protocol", () => {
    const host = claimUrlHost();
    expect(host).toBe(`${getMainSiteHost()}/claim`);
    expect(host).not.toContain("://");
  });
});
