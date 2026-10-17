import { beforeEach, describe, expect, test, vi } from "vitest";

const getCustomerOtpResendState = vi.fn();
const recordIpThrottleAttempt = vi.fn();

vi.mock("@ammari/auth/customer", () => ({
  getCustomerOtpResendState: (...args: unknown[]) => getCustomerOtpResendState(...args),
}));
vi.mock("@ammari/auth/ip-throttle", () => ({
  recordIpThrottleAttempt: (...args: unknown[]) => recordIpThrottleAttempt(...args),
}));
vi.mock("@ammari/db", () => ({ db: {} }));

const { POST } = await import("./route");

function postRequest(body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): Request {
  return new Request("http://localhost:3000/api/otp-resend-state", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getCustomerOtpResendState.mockReset().mockResolvedValue({ cooldownRemainingSeconds: 0, hasActiveCode: false });
  recordIpThrottleAttempt.mockReset().mockResolvedValue({ limited: false });
});

describe("POST /api/otp-resend-state (web)", () => {
  test("rejects a missing email with 400, never calling getCustomerOtpResendState", async () => {
    const response = await POST(postRequest({}) as never);
    expect(response.status).toBe(400);
    expect(getCustomerOtpResendState).not.toHaveBeenCalled();
  });

  test("rejects a non-string email with 400", async () => {
    const response = await POST(postRequest({ email: 123 }) as never);
    expect(response.status).toBe(400);
    expect(getCustomerOtpResendState).not.toHaveBeenCalled();
  });

  test("rejects a malformed JSON body with 400", async () => {
    const request = new Request("http://localhost:3000/api/otp-resend-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const response = await POST(request as never);
    expect(response.status).toBe(400);
    expect(getCustomerOtpResendState).not.toHaveBeenCalled();
  });

  test("returns the resend state as-is for a valid email (no cooldown)", async () => {
    getCustomerOtpResendState.mockResolvedValue({ cooldownRemainingSeconds: 0, hasActiveCode: false });
    const response = await POST(postRequest({ email: "customer@example.test" }) as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cooldownRemainingSeconds: 0, hasActiveCode: false });
    expect(getCustomerOtpResendState).toHaveBeenCalledWith({}, "customer@example.test");
  });

  test("returns Case A (an active code, still within cooldown)", async () => {
    getCustomerOtpResendState.mockResolvedValue({ cooldownRemainingSeconds: 42, hasActiveCode: true });
    const response = await POST(postRequest({ email: "customer@example.test" }) as never);
    expect(await response.json()).toEqual({ cooldownRemainingSeconds: 42, hasActiveCode: true });
  });

  test("returns Case B (no active code, still within cooldown)", async () => {
    getCustomerOtpResendState.mockResolvedValue({ cooldownRemainingSeconds: 42, hasActiveCode: false });
    const response = await POST(postRequest({ email: "customer@example.test" }) as never);
    expect(await response.json()).toEqual({ cooldownRemainingSeconds: 42, hasActiveCode: false });
  });
});

describe("POST /api/otp-resend-state (web) — per-IP rate limit", () => {
  test("reads the IP from cf-connecting-ip and checks the throttle before doing anything else", async () => {
    await POST(postRequest({ email: "customer@example.test" }, { "content-type": "application/json", "cf-connecting-ip": "203.0.113.5" }) as never);
    expect(recordIpThrottleAttempt).toHaveBeenCalledWith({}, "203.0.113.5", { windowSeconds: 600, max: 30 });
  });

  test("falls back to a shared 'unknown' bucket when cf-connecting-ip is absent (never skips the check)", async () => {
    await POST(postRequest({ email: "customer@example.test" }) as never);
    expect(recordIpThrottleAttempt).toHaveBeenCalledWith({}, "unknown", { windowSeconds: 600, max: 30 });
  });

  test("returns 429 and never calls getCustomerOtpResendState once the IP is limited", async () => {
    recordIpThrottleAttempt.mockResolvedValue({ limited: true });
    const response = await POST(postRequest({ email: "customer@example.test" }) as never);
    expect(response.status).toBe(429);
    expect(getCustomerOtpResendState).not.toHaveBeenCalled();
  });

  test("the 429 response body reveals nothing about the email or any account", async () => {
    recordIpThrottleAttempt.mockResolvedValue({ limited: true });
    const response = await POST(postRequest({ email: "customer@example.test" }) as never);
    const body: unknown = await response.json();
    expect(body).toEqual({ error: "rate_limited" });
  });

  test("a malformed body is still checked against the IP throttle first (429 wins over 400)", async () => {
    recordIpThrottleAttempt.mockResolvedValue({ limited: true });
    const request = new Request("http://localhost:3000/api/otp-resend-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const response = await POST(request as never);
    expect(response.status).toBe(429);
  });

  test("proceeds normally once the IP is not limited", async () => {
    getCustomerOtpResendState.mockResolvedValue({ cooldownRemainingSeconds: 0, hasActiveCode: false });
    const response = await POST(postRequest({ email: "customer@example.test" }) as never);
    expect(response.status).toBe(200);
    expect(getCustomerOtpResendState).toHaveBeenCalled();
  });
});

describe("POST /api/otp-resend-state (web) — never reveals account existence", () => {
  test("an unknown email gets the exact same response shape as any other (no existence signal)", async () => {
    getCustomerOtpResendState.mockResolvedValue({ cooldownRemainingSeconds: 0, hasActiveCode: false });
    const response = await POST(postRequest({ email: "definitely-not-a-real-customer@example.test" }) as never);
    const body: unknown = await response.json();
    expect(Object.keys(body as object).sort()).toEqual(["cooldownRemainingSeconds", "hasActiveCode"]);
  });
});
