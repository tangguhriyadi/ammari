import { describe, expect, test } from "vitest";
import { hashClaimToken, normalizeClaimTokenInput } from "./token";

describe("normalizeClaimTokenInput", () => {
  test("strips dashes/whitespace and uppercases", () => {
    expect(normalizeClaimTokenInput("abcd-efgh-ijkl")).toBe("ABCDEFGHIJKL");
    expect(normalizeClaimTokenInput("  abcd efgh  ")).toBe("ABCDEFGH");
  });

  test("strips every non-alphanumeric character, not just dashes/spaces", () => {
    expect(normalizeClaimTokenInput("ab.cd_ef/gh\\ij")).toBe("ABCDEFGHIJ");
  });

  test("a blank/garbled code normalizes to an empty string rather than throwing", () => {
    expect(normalizeClaimTokenInput("   ---   ")).toBe("");
  });

  test("hand-typed and scanned forms of the same token normalize identically", () => {
    expect(normalizeClaimTokenInput("abcd-efgh-ijkl-mnop")).toBe(normalizeClaimTokenInput("ABCDEFGHIJKLMNOP"));
  });
});

describe("hashClaimToken", () => {
  test("is a deterministic sha256 hex digest of the input string", () => {
    const hash = hashClaimToken("ABCDEFGHIJKL");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashClaimToken("ABCDEFGHIJKL")).toBe(hash);
  });

  test("different normalized tokens hash differently", () => {
    expect(hashClaimToken("ABCDEFGHIJKL")).not.toBe(hashClaimToken("ABCDEFGHIJKM"));
  });
});
