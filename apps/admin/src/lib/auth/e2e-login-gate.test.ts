import { describe, expect, test } from "vitest";
import { isE2eLoginRequestAllowed } from "./e2e-login-gate";

function baseInput() {
  return {
    nodeEnv: "test",
    e2eTestLoginFlag: "true",
    email: "super-admin@e2e.ammari.test",
    host: "localhost:3001",
    forwardedFor: null,
  };
}

describe("isE2eLoginRequestAllowed", () => {
  test("allows when all four conditions hold", () => {
    expect(isE2eLoginRequestAllowed(baseInput())).toBe(true);
  });

  test("denies when NODE_ENV is production", () => {
    expect(isE2eLoginRequestAllowed({ ...baseInput(), nodeEnv: "production" })).toBe(false);
  });

  test("denies when E2E_TEST_LOGIN is not exactly \"true\"", () => {
    expect(isE2eLoginRequestAllowed({ ...baseInput(), e2eTestLoginFlag: undefined })).toBe(false);
    expect(isE2eLoginRequestAllowed({ ...baseInput(), e2eTestLoginFlag: "false" })).toBe(false);
  });

  test("denies an email that is not an @e2e.ammari.test fixture", () => {
    expect(isE2eLoginRequestAllowed({ ...baseInput(), email: "owner@ammari.id" })).toBe(false);
  });

  test("denies a non-localhost Host header", () => {
    expect(isE2eLoginRequestAllowed({ ...baseInput(), host: "admin.ammari.my.id" })).toBe(false);
  });

  test("denies a non-loopback x-forwarded-for client", () => {
    expect(isE2eLoginRequestAllowed({ ...baseInput(), forwardedFor: "203.0.113.5" })).toBe(false);
  });

  test("allows a loopback x-forwarded-for client", () => {
    expect(isE2eLoginRequestAllowed({ ...baseInput(), forwardedFor: "127.0.0.1" })).toBe(true);
  });

  test("allows a bracketed IPv6 loopback Host header", () => {
    expect(isE2eLoginRequestAllowed({ ...baseInput(), host: "[::1]:3001" })).toBe(true);
  });

  test("denies a bracketed IPv6 non-loopback Host header", () => {
    expect(isE2eLoginRequestAllowed({ ...baseInput(), host: "[2001:db8::1]:3001" })).toBe(false);
  });
});
