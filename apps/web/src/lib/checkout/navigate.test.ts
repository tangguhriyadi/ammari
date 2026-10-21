import { describe, expect, test } from "vitest";
import { isSafePaymentUrl } from "./navigate";

describe("isSafePaymentUrl", () => {
  test("https pages and this site's own pages only", () => {
    const origin = "http://localhost:3100";
    expect(isSafePaymentUrl("https://app.sandbox.example/snap/v4/redirection/abc", origin)).toBe(true);
    expect(isSafePaymentUrl("http://localhost:3100/api/test/payments/E2E-ORD-202610-0001-1", origin)).toBe(true);
    expect(isSafePaymentUrl("/checkout/finish?order=ORD-202610-0001", origin)).toBe(true);
    expect(isSafePaymentUrl("http://evil.example/pay", origin)).toBe(false);
    expect(isSafePaymentUrl("javascript:alert(1)", origin)).toBe(false);
  });
});
