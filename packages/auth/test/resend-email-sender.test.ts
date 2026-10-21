import { afterEach, describe, expect, test, vi } from "vitest";
import { EmailDeliveryError, ResendEmailSender } from "../src/resend-email-sender";

// The Resend REST call with a stubbed fetch (nothing reaches Resend). The API key is a
// placeholder built at runtime, never a key-shaped literal.
const apiKey = ["test", "resend", "placeholder"].join("-");
const sender = new ResendEmailSender({ apiKey, from: "Ammari <noreply@example.test>" });

afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(response: Response | Error) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

describe("ResendEmailSender", () => {
  test("sends text, html and the idempotency key; never follows a redirect", async () => {
    const fetchSpy = stubFetch(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    await sender.send({ to: "buyer@example.test", subject: "Halo", body: "teks", html: "<p>teks</p>", idempotencyKey: "order-notification/abc" });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.resend.com/emails");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("order-notification/abc");
    expect(headers.Authorization).toBe(`Bearer ${apiKey}`);
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ from: "Ammari <noreply@example.test>", to: ["buyer@example.test"], subject: "Halo", text: "teks", html: "<p>teks</p>" });
  });

  test("an OTP-style message without html or key sends neither", async () => {
    const fetchSpy = stubFetch(new Response("{}", { status: 200 }));
    await sender.send({ to: "a@example.test", subject: "Kode", body: "123456" });
    const init = fetchSpy.mock.calls[0]![1];
    expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("html");
  });

  test("a refusal throws the status and Resend's error name, never the body (it can echo the address)", async () => {
    stubFetch(new Response(JSON.stringify({ name: "validation_error", message: "Invalid `to` field: buyer@example.test" }), { status: 422 }));
    const error = await sender.send({ to: "buyer@example.test", subject: "x", body: "y" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error).toMatchObject({ status: 422, providerError: "validation_error" });
    expect(String((error as Error).message)).not.toContain("buyer@example.test");
  });

  test("a network failure is an EmailDeliveryError without a status", async () => {
    stubFetch(new TypeError("fetch failed"));
    await expect(sender.send({ to: "a@example.test", subject: "x", body: "y" })).rejects.toMatchObject({ name: "EmailDeliveryError", status: null, providerError: "network_error" });
  });
});
