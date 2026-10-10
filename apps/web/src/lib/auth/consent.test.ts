import { describe, expect, test } from "vitest";
import { decideConsentGate, needsConsent } from "./consent";
import type { CustomerSessionData } from "./customer-session";

function customer(overrides: Partial<CustomerSessionData> = {}): CustomerSessionData {
  return {
    id: "customer-1",
    name: "Test Customer",
    email: "test@example.test",
    phone: null,
    pdpConsentAt: null,
    promoConsentAt: null,
    ...overrides,
  };
}

describe("needsConsent", () => {
  test("true when pdp_consent_at is null", () => {
    expect(needsConsent(customer({ pdpConsentAt: null }))).toBe(true);
  });

  test("false once pdp_consent_at is set", () => {
    expect(needsConsent(customer({ pdpConsentAt: new Date() }))).toBe(false);
  });
});

describe("decideConsentGate", () => {
  test("no session -> redirect to /login carrying `next`", () => {
    const decision = decideConsentGate(null, "/account");
    expect(decision).toEqual({ action: "redirect", to: "/login?next=%2Faccount" });
  });

  test("a session without consent -> redirect to /consent carrying `next`", () => {
    const decision = decideConsentGate(customer({ pdpConsentAt: null }), "/account");
    expect(decision).toEqual({ action: "redirect", to: "/consent?next=%2Faccount" });
  });

  test("a consented session -> allow, with the live customer passed through", () => {
    const c = customer({ pdpConsentAt: new Date("2026-01-01T00:00:00Z") });
    const decision = decideConsentGate(c, "/account");
    expect(decision).toEqual({ action: "allow", customer: c });
  });

  test("`next` is URL-encoded in both redirect targets", () => {
    const decision = decideConsentGate(null, "/claim/abc?foo=bar");
    expect(decision).toEqual({ action: "redirect", to: "/login?next=%2Fclaim%2Fabc%3Ffoo%3Dbar" });
  });
});
