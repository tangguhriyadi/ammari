import { describe, expect, test } from "vitest";
import { sanitizeNextPath } from "./next-path";

describe("sanitizeNextPath", () => {
  test("passes through a plain internal path", () => {
    expect(sanitizeNextPath("/account")).toBe("/account");
    expect(sanitizeNextPath("/claim/abc123?foo=bar")).toBe("/claim/abc123?foo=bar");
  });

  test("falls back to the default when missing", () => {
    expect(sanitizeNextPath(undefined)).toBe("/account");
  });

  test("rejects a protocol-relative URL", () => {
    expect(sanitizeNextPath("//evil.com")).toBe("/account");
  });

  test("rejects an absolute URL", () => {
    expect(sanitizeNextPath("https://evil.com")).toBe("/account");
  });

  test("rejects a backslash variant", () => {
    expect(sanitizeNextPath("/\\evil.com")).toBe("/account");
    expect(sanitizeNextPath("\\\\evil.com")).toBe("/account");
  });

  test("rejects a tab/newline-smuggled protocol-relative URL (WHATWG strips these before parsing)", () => {
    expect(sanitizeNextPath("/\t/evil.com")).toBe("/account");
    expect(sanitizeNextPath("/\n/evil.com")).toBe("/account");
    expect(sanitizeNextPath("/\r/evil.com")).toBe("/account");
  });

  test("rejects an encoded path separator", () => {
    expect(sanitizeNextPath("/%2f/evil.com")).toBe("/account");
    expect(sanitizeNextPath("/%5cevil.com")).toBe("/account");
  });

  test("rejects a javascript: URI", () => {
    expect(sanitizeNextPath("javascript:alert(1)")).toBe("/account");
  });

  test("takes the first value when given an array (e.g. a repeated query param)", () => {
    expect(sanitizeNextPath(["/account", "/other"])).toBe("/account");
  });
});
