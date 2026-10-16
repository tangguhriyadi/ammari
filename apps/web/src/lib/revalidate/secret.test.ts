import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { constantTimeEqual, isValidRevalidateSecret } from "./secret";

describe("constantTimeEqual", () => {
  test("true for identical strings", () => {
    expect(constantTimeEqual("same-secret", "same-secret")).toBe(true);
  });

  test("false for different strings of the same length", () => {
    expect(constantTimeEqual("secret-aaaa", "secret-bbbb")).toBe(false);
  });

  test("false for different lengths, without throwing", () => {
    expect(constantTimeEqual("short", "a-lot-longer-string")).toBe(false);
  });

  test("false against an empty string", () => {
    expect(constantTimeEqual("", "non-empty")).toBe(false);
  });
});

describe("isValidRevalidateSecret", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.REVALIDATE_SECRET;
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.REVALIDATE_SECRET;
    else process.env.REVALIDATE_SECRET = savedSecret;
  });

  test("accepts the exact configured secret", () => {
    process.env.REVALIDATE_SECRET = "correct-secret-value";
    expect(isValidRevalidateSecret("correct-secret-value")).toBe(true);
  });

  test("rejects a wrong secret", () => {
    process.env.REVALIDATE_SECRET = "correct-secret-value";
    expect(isValidRevalidateSecret("wrong-secret-value")).toBe(false);
  });

  test("rejects a missing header", () => {
    process.env.REVALIDATE_SECRET = "correct-secret-value";
    expect(isValidRevalidateSecret(null)).toBe(false);
  });

  test("rejects an empty-string header", () => {
    process.env.REVALIDATE_SECRET = "correct-secret-value";
    expect(isValidRevalidateSecret("")).toBe(false);
  });

  test("fails closed when REVALIDATE_SECRET itself is unset, never accepting anything", () => {
    delete process.env.REVALIDATE_SECRET;
    expect(isValidRevalidateSecret("anything")).toBe(false);
    expect(isValidRevalidateSecret("")).toBe(false);
  });
});
