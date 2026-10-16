import { describe, expect, test } from "vitest";
import { isE2ePreviewTokenRequestAllowed } from "./e2e-gate";

function input(overrides: Partial<Parameters<typeof isE2ePreviewTokenRequestAllowed>[0]> = {}) {
  return { nodeEnv: "development", e2eTestLoginFlag: "true", host: "localhost:3100", ...overrides };
}

describe("isE2ePreviewTokenRequestAllowed", () => {
  test("allows a well-formed localhost e2e request", () => {
    expect(isE2ePreviewTokenRequestAllowed(input())).toBe(true);
  });

  test("rejects when NODE_ENV is production, regardless of everything else", () => {
    expect(isE2ePreviewTokenRequestAllowed(input({ nodeEnv: "production" }))).toBe(false);
  });

  test("rejects when E2E_TEST_LOGIN is not exactly \"true\"", () => {
    expect(isE2ePreviewTokenRequestAllowed(input({ e2eTestLoginFlag: undefined }))).toBe(false);
    expect(isE2ePreviewTokenRequestAllowed(input({ e2eTestLoginFlag: "1" }))).toBe(false);
  });

  test("rejects a non-loopback host", () => {
    expect(isE2ePreviewTokenRequestAllowed(input({ host: "ammari.my.id" }))).toBe(false);
  });

  test("accepts IPv6 loopback, bracketed with a port", () => {
    expect(isE2ePreviewTokenRequestAllowed(input({ host: "[::1]:3100" }))).toBe(true);
  });

  test("rejects a missing Host header", () => {
    expect(isE2ePreviewTokenRequestAllowed(input({ host: null }))).toBe(false);
  });
});
