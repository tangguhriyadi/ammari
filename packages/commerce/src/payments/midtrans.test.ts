import { describe, expect, test, vi } from "vitest";
import { createFakePaymentProvider, recordFakeTransaction } from "./fake";
import { MIDTRANS_ENABLED_PAYMENTS, createMidtransPaymentProvider, midtransStartTime } from "./midtrans";
import { PaymentProviderError, type CreatePaymentInput } from "./provider";
import { midtransSignature, parsePaymentStatusBody, parseWholeRupiah, verifyMidtransSignature } from "./status";
import { fakeMidtransServerKey } from "../../test/fake-keys";

// docs/plans/cart-checkout.md D5 to D8, §6.1, §13: the Midtrans Snap and status client against a
// stub fetch, the signature, and the status parsing. Fixtures are hand-written from the documented
// examples (docs.midtrans.com, read 2026-10-21), never recorded from a real call; nothing here
// reaches Midtrans (test/setup.ts refuses non-local fetch anyway).

const SERVER_KEY = fakeMidtransServerKey("sandbox");

const input: CreatePaymentInput = {
  providerOrderId: "LOCAL-ORD-202612-0001-1",
  grossAmount: 573_000,
  lines: [
    { id: "GB-BLK-M", name: "Gamis Basic Black M", price: 259_000, quantity: 2 },
    { id: "SHIPPING", name: "Ongkir", price: 75_000, quantity: 1 },
    { id: "VOUCHER", name: "Voucher", price: -20_000, quantity: 1 },
  ],
  customer: { name: "Siti Aminah binti Abdullah Al Fulani", email: "siti@example.test", phone: "+6281234567890" },
  expiryMinutes: 60,
  finishUrl: "https://ammari.my.id/checkout/finish?order=ORD-202612-0001",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The documented BCA VA settlement notification / status body, with our ids. */
function statusBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_time: "2026-12-01 10:00:00",
    transaction_status: "settlement",
    transaction_id: "9aed5972-5b6a-401e-894b-a32c91ed1a3a",
    status_message: "midtrans payment notification",
    status_code: "200",
    signature_key: "x",
    settlement_time: "2026-12-01 10:05:00",
    payment_type: "bank_transfer",
    order_id: "LOCAL-ORD-202612-0001-1",
    merchant_id: "G000000000",
    gross_amount: "573000.00",
    fraud_status: "accept",
    currency: "IDR",
    va_numbers: [{ va_number: "91019021579", bank: "bca" }],
    ...overrides,
  };
}

const NOW = new Date("2026-12-01T03:00:00Z");

describe("createPayment (Snap)", () => {
  test("posts the documented body with Basic auth, the override notification URL and a Jakarta start time", async () => {
    const fetch = vi.fn(async () => jsonResponse(201, { token: "snap-token", redirect_url: "https://app.sandbox.midtrans.com/snap/v4/redirection/snap-token" }));
    const provider = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: false, notificationUrl: "https://ammari.my.id/api/payments/midtrans/notification", fetch, now: () => NOW });

    expect(await provider.createPayment(input)).toEqual({ token: "snap-token", redirectUrl: "https://app.sandbox.midtrans.com/snap/v4/redirection/snap-token" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.sandbox.midtrans.com/snap/v1/transactions");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from(`${SERVER_KEY}:`).toString("base64")}`);
    expect(headers["x-override-notification"]).toBe("https://ammari.my.id/api/payments/midtrans/notification");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      transaction_details: { order_id: "LOCAL-ORD-202612-0001-1", gross_amount: 573_000 },
      item_details: [
        { id: "GB-BLK-M", price: 259_000, quantity: 2, name: "Gamis Basic Black M" },
        { id: "SHIPPING", price: 75_000, quantity: 1, name: "Ongkir" },
        { id: "VOUCHER", price: -20_000, quantity: 1, name: "Voucher" },
      ],
      // Cut to BCA VA's 30 characters.
      customer_details: { first_name: "Siti Aminah binti Abdullah Al", email: "siti@example.test", phone: "+6281234567890" },
      enabled_payments: [...MIDTRANS_ENABLED_PAYMENTS],
      callbacks: { finish: "https://ammari.my.id/checkout/finish?order=ORD-202612-0001" },
      expiry: { start_time: "2026-12-01 10:00:00 +0700", unit: "minute", duration: 60 },
      page_expiry: { duration: 60, unit: "minute" },
    });
    // item_details sum to gross_amount (Midtrans refuses a mismatch).
    expect(body.item_details.reduce((sum: number, line: { price: number; quantity: number }) => sum + line.price * line.quantity, 0)).toBe(573_000);
    // No card method, ever (D16).
    expect(body.enabled_payments).not.toContain("credit_card");
  });

  test("no override header without a notification URL; the production host in production mode", async () => {
    const fetch = vi.fn(async () => jsonResponse(201, { token: "t", redirect_url: "https://app.midtrans.com/snap/v4/redirection/t" }));
    const provider = createMidtransPaymentProvider({ serverKey: fakeMidtransServerKey("production"), isProduction: true, notificationUrl: null, fetch });
    await provider.createPayment(input);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.midtrans.com/snap/v1/transactions");
    expect((init.headers as Record<string, string>)["x-override-notification"]).toBeUndefined();
  });

  test("refuses a redirect URL that is not Snap's https host for the mode", async () => {
    for (const redirect of ["http://app.sandbox.midtrans.com/x", "https://evil.test/x", "https://app.midtrans.com/x", "javascript:alert(1)"]) {
      const provider = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: false, notificationUrl: null, fetch: async () => jsonResponse(201, { token: "t", redirect_url: redirect }) });
      await expect(provider.createPayment(input)).rejects.toMatchObject({ reason: "bad_response" });
    }
  });

  test("maps errors: 401 / 406 / 500 unavailable without echoing messages, a missing token bad_response, a network error unavailable", async () => {
    const cases: [Response | Error, string][] = [
      [jsonResponse(401, { error_messages: ["Access denied due to unauthorized transaction, please check client or server key"] }), "unavailable"],
      [jsonResponse(406, { error_messages: ["Duplicate order ID. siti@example.test"] }), "unavailable"],
      [jsonResponse(500, { error_messages: ["Sorry. Our system is recovering from unexpected issues. Please retry."] }), "unavailable"],
      [jsonResponse(201, { redirect_url: "https://app.sandbox.midtrans.com/x" }), "bad_response"],
      [new TypeError("fetch failed"), "unavailable"],
    ];
    for (const [answer, reason] of cases) {
      const provider = createMidtransPaymentProvider({
        serverKey: SERVER_KEY,
        isProduction: false,
        notificationUrl: null,
        fetch: async () => {
          if (answer instanceof Error) throw answer;
          return answer;
        },
      });
      const error = await provider.createPayment(input).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PaymentProviderError);
      expect((error as PaymentProviderError).reason).toBe(reason);
      expect(JSON.stringify((error as PaymentProviderError).logFields())).not.toMatch(/siti/);
      expect(JSON.stringify((error as PaymentProviderError).logFields())).not.toContain(SERVER_KEY);
    }
  });

  test("a 401 is a rejected key (missing, wrong, or for the other environment): unavailable, flagged, named but never printed", async () => {
    for (const isProduction of [false, true]) {
      const provider = createMidtransPaymentProvider({
        serverKey: SERVER_KEY,
        isProduction,
        notificationUrl: null,
        fetch: async () => jsonResponse(401, { error_messages: ["Access denied due to unauthorized transaction, please check client or server key"] }),
      });
      const error = (await provider.createPayment(input).catch((caught: unknown) => caught)) as PaymentProviderError;
      expect(error).toBeInstanceOf(PaymentProviderError);
      expect(error.reason).toBe("unavailable");
      expect(error.keyRejected).toBe(true);
      const logged = error.logFields();
      expect(logged).toMatchObject({ reason: "unavailable", status: 401, keyRejected: true });
      expect(String(logged.message)).toContain("MIDTRANS_SERVER_KEY");
      expect(String(logged.message)).toContain("wrong key for this environment");
      expect(String(logged.message)).toContain(isProduction ? "production" : "sandbox");
      expect(JSON.stringify(logged)).not.toContain(SERVER_KEY);
    }
    // Any other failure is not reported as a key problem.
    const other = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: false, notificationUrl: null, fetch: async () => jsonResponse(500, {}) });
    const error = (await other.createPayment(input).catch((caught: unknown) => caught)) as PaymentProviderError;
    expect(error.keyRejected).toBe(false);
    expect(error.logFields()).not.toHaveProperty("keyRejected");
  });

  test("honours the caller's abort signal", async () => {
    const controller = new AbortController();
    const provider = createMidtransPaymentProvider({
      serverKey: SERVER_KEY,
      isProduction: false,
      notificationUrl: null,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    });
    const pending = provider.createPayment({ ...input, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "unavailable" });
  });

  test("the start time is Jakarta wall-clock time", () => {
    expect(midtransStartTime(new Date("2026-12-31T20:05:09Z"))).toBe("2027-01-01 03:05:09 +0700");
  });
});

describe("getPaymentStatus", () => {
  test("GET /v2/{order_id}/status on the API host, parsed", async () => {
    const fetch = vi.fn(async () => jsonResponse(200, statusBody()));
    const provider = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: false, notificationUrl: null, fetch });
    const report = await provider.getPaymentStatus("LOCAL-ORD-202612-0001-1");
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("https://api.sandbox.midtrans.com/v2/LOCAL-ORD-202612-0001-1/status");
    expect(report).toMatchObject({
      providerOrderId: "LOCAL-ORD-202612-0001-1",
      transactionStatus: "settlement",
      transactionId: "9aed5972-5b6a-401e-894b-a32c91ed1a3a",
      paymentType: "bank_transfer",
      grossAmount: 573_000,
      currency: "IDR",
      fraudStatus: "accept",
    });
    // The snapshot keeps the bank, never the VA number or the signature.
    expect(report?.snapshot).toMatchObject({ bank: "bca", transaction_status: "settlement" });
    expect(JSON.stringify(report?.snapshot)).not.toMatch(/91019021579|signature/);
  });

  test("404 (HTTP or body status_code) is null: no transaction yet", async () => {
    for (const response of [jsonResponse(404, { status_code: "404", status_message: "Transaction doesn't exist." }), jsonResponse(200, { status_code: "404", status_message: "Transaction doesn't exist." })]) {
      const provider = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: false, notificationUrl: null, fetch: async () => response });
      expect(await provider.getPaymentStatus("LOCAL-ORD-202612-0001-1")).toBeNull();
    }
  });

  test("a key problem, another order's body, or a wrong shape is an error; a 5xx is retried once", async () => {
    const unauthorized = createMidtransPaymentProvider({
      serverKey: SERVER_KEY,
      isProduction: false,
      notificationUrl: null,
      fetch: async () => jsonResponse(200, { status_code: "401", status_message: "Transaction cannot be authorized with the current client/server key." }),
    });
    await expect(unauthorized.getPaymentStatus("LOCAL-ORD-202612-0001-1")).rejects.toMatchObject({ reason: "unavailable", keyRejected: true });
    const unauthorizedHttp = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: true, notificationUrl: null, fetch: async () => jsonResponse(401, { status_code: "401" }) });
    const rejected = (await unauthorizedHttp.getPaymentStatus("LOCAL-ORD-202612-0001-1").catch((caught: unknown) => caught)) as PaymentProviderError;
    expect(rejected).toMatchObject({ reason: "unavailable", keyRejected: true, status: 401 });
    expect(JSON.stringify(rejected.logFields())).not.toContain(SERVER_KEY);

    const other = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: false, notificationUrl: null, fetch: async () => jsonResponse(200, statusBody({ order_id: "LOCAL-ORD-202612-0002-1" })) });
    await expect(other.getPaymentStatus("LOCAL-ORD-202612-0001-1")).rejects.toMatchObject({ reason: "bad_response" });

    const shapeless = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: false, notificationUrl: null, fetch: async () => jsonResponse(200, { hello: "world" }) });
    await expect(shapeless.getPaymentStatus("LOCAL-ORD-202612-0001-1")).rejects.toMatchObject({ reason: "bad_response" });

    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(503, {})).mockResolvedValueOnce(jsonResponse(200, statusBody()));
    const retried = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: false, notificationUrl: null, fetch, retryDelayMs: 0 });
    expect((await retried.getPaymentStatus("LOCAL-ORD-202612-0001-1"))?.transactionStatus).toBe("settlement");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("getPaymentStatus retries", () => {
  test("a network error is retried once; a timeout is not", async () => {
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(jsonResponse(200, statusBody()));
    const provider = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: false, notificationUrl: null, fetch: flaky, retryDelayMs: 0 });
    expect((await provider.getPaymentStatus("LOCAL-ORD-202612-0001-1"))?.transactionStatus).toBe("settlement");
    expect(flaky).toHaveBeenCalledTimes(2);

    const slow = vi.fn(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    const timing = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: false, notificationUrl: null, fetch: slow, retryDelayMs: 0 });
    await expect(timing.getPaymentStatus("LOCAL-ORD-202612-0001-1")).rejects.toMatchObject({ reason: "unavailable" });
    expect(slow).toHaveBeenCalledTimes(1);
  });
});

describe("expirePayment (expiry sweep)", () => {
  const ORDER_ID = "LOCAL-ORD-202612-0001-1";
  const expired = () => statusBody({ status_code: "407", status_message: "Success, transaction has expired", transaction_status: "expire", settlement_time: undefined });

  test("POST /v2/{order_id}/expire on the API host with Basic auth, no retry needed; the answer is a status report", async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => jsonResponse(200, expired()));
    const provider = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: false, notificationUrl: null, fetch: fetch as unknown as typeof globalThis.fetch });
    const report = await provider.expirePayment(ORDER_ID);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.sandbox.midtrans.com/v2/LOCAL-ORD-202612-0001-1/expire");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from(`${SERVER_KEY}:`).toString("base64")}`);
    expect(init.redirect).toBe("error");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ providerOrderId: ORDER_ID, transactionStatus: "expire", grossAmount: 573_000 });

    const production = vi.fn(async (..._args: unknown[]) => jsonResponse(200, expired()));
    await createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: true, notificationUrl: null, fetch: production as unknown as typeof globalThis.fetch }).expirePayment(ORDER_ID);
    expect((production.mock.calls[0] as unknown as [string])[0]).toBe("https://api.midtrans.com/v2/LOCAL-ORD-202612-0001-1/expire");
  });

  test("404 (no transaction) and 412 (no longer pending), as HTTP or body status_code, are null: the caller re-reads the status", async () => {
    for (const response of [
      () => jsonResponse(404, { status_code: "404", status_message: "Transaction doesn't exist." }),
      () => jsonResponse(200, { status_code: "404", status_message: "Transaction doesn't exist." }),
      () => jsonResponse(412, { status_code: "412", status_message: "Merchant cannot modify the status of the transaction" }),
      () => jsonResponse(200, { status_code: "412", status_message: "Merchant cannot modify the status of the transaction" }),
    ]) {
      const provider = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: false, notificationUrl: null, fetch: async () => response() });
      expect(await provider.expirePayment(ORDER_ID)).toBeNull();
    }
  });

  test("a key problem or 5xx is unavailable (a 5xx retried once), an unexpected answer is bad_response", async () => {
    const cases: [() => Response, PaymentProviderError["reason"]][] = [
      [() => jsonResponse(200, { status_code: "401", status_message: "Transaction cannot be authorized with the current client/server key." }), "unavailable"],
      [() => jsonResponse(401, { status_code: "401" }), "unavailable"],
      [() => jsonResponse(503, { status_code: "503" }), "unavailable"],
      [() => jsonResponse(200, statusBody()), "bad_response"],
      [() => jsonResponse(200, { status_code: "407", order_id: ORDER_ID }), "bad_response"],
      [() => jsonResponse(200, { ...expired(), order_id: "LOCAL-ORD-202612-0002-1" }), "bad_response"],
    ];
    for (const [index, [response, reason]] of cases.entries()) {
      const fetch = vi.fn(async () => response());
      const provider = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: false, notificationUrl: null, fetch, retryDelayMs: 0 });
      const error = await provider.expirePayment(ORDER_ID).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PaymentProviderError);
      expect((error as PaymentProviderError).reason).toBe(reason);
      // The first two cases are a 401 (in the body, then as HTTP status): a rejected key.
      expect((error as PaymentProviderError).keyRejected).toBe(index < 2);
      if (response().status === 503) expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  test("a 5xx is retried once: the second answer (407) counts; a 412 after a lost first answer is null", async () => {
    const answers = [jsonResponse(502, {}), jsonResponse(200, expired())];
    const fetch = vi.fn(async () => answers.shift() ?? jsonResponse(500, {}));
    const provider = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: false, notificationUrl: null, fetch, retryDelayMs: 0 });
    expect(await provider.expirePayment(ORDER_ID)).toMatchObject({ transactionStatus: "expire" });
    expect(fetch).toHaveBeenCalledTimes(2);
    const lost = [jsonResponse(503, {}), jsonResponse(200, { status_code: "412", status_message: "Merchant cannot modify the status of the transaction" })];
    const again = createMidtransPaymentProvider({ serverKey: SERVER_KEY, isProduction: false, notificationUrl: null, fetch: async () => lost.shift() ?? jsonResponse(500, {}), retryDelayMs: 0 });
    expect(await again.expirePayment(ORDER_ID)).toBeNull();
  });

  test("a network error is retried once; a timeout is not", async () => {
    let calls = 0;
    const flaky = createMidtransPaymentProvider({
      serverKey: SERVER_KEY,
      isProduction: false,
      notificationUrl: null,
      retryDelayMs: 0,
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return jsonResponse(200, expired());
      },
    });
    expect(await flaky.expirePayment(ORDER_ID)).toMatchObject({ transactionStatus: "expire" });
    expect(calls).toBe(2);

    let slowCalls = 0;
    const slow = createMidtransPaymentProvider({
      serverKey: SERVER_KEY,
      isProduction: false,
      notificationUrl: null,
      statusTimeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_, reject) => {
          slowCalls += 1;
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    await expect(slow.expirePayment(ORDER_ID)).rejects.toMatchObject({ reason: "unavailable", message: "Midtrans expire request timed out" });
    expect(slowCalls).toBe(1);
  });
});

describe("signature", () => {
  test("SHA512(order_id + status_code + gross_amount + server key), constant-time verify", () => {
    const fields = { orderId: "LOCAL-ORD-202612-0001-1", statusCode: "200", grossAmount: "573000.00" };
    const signature = midtransSignature(fields, SERVER_KEY);
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyMidtransSignature({ ...fields, signatureKey: signature }, SERVER_KEY)).toBe(true);
    expect(verifyMidtransSignature({ ...fields, signatureKey: signature.toUpperCase() }, SERVER_KEY)).toBe(true);
    // Any signed field changed, another key, a truncated or junk signature: false.
    expect(verifyMidtransSignature({ ...fields, grossAmount: "573000", signatureKey: signature }, SERVER_KEY)).toBe(false);
    expect(verifyMidtransSignature({ ...fields, statusCode: "201", signatureKey: signature }, SERVER_KEY)).toBe(false);
    expect(verifyMidtransSignature({ ...fields, signatureKey: signature }, fakeMidtransServerKey("sandbox", "OTHER"))).toBe(false);
    expect(verifyMidtransSignature({ ...fields, signatureKey: signature.slice(0, 64) }, SERVER_KEY)).toBe(false);
    expect(verifyMidtransSignature({ ...fields, signatureKey: "z".repeat(128) }, SERVER_KEY)).toBe(false);
    expect(verifyMidtransSignature({ ...fields, signatureKey: signature }, "")).toBe(false);
  });
});

describe("parsing", () => {
  test("whole rupiah only", () => {
    expect(parseWholeRupiah("573000.00")).toBe(573_000);
    expect(parseWholeRupiah("573000")).toBe(573_000);
    expect(parseWholeRupiah(573_000)).toBe(573_000);
    expect(parseWholeRupiah("573000.50")).toBeNull();
    expect(parseWholeRupiah("-1")).toBeNull();
    expect(parseWholeRupiah("1e6")).toBeNull();
    expect(parseWholeRupiah(null)).toBeNull();
  });

  test("statuses are lower-cased; a body without order id or status is refused", () => {
    expect(parsePaymentStatusBody(statusBody({ transaction_status: "SETTLEMENT" }))?.transactionStatus).toBe("settlement");
    expect(parsePaymentStatusBody({ transaction_status: "settlement" })).toBeNull();
    expect(parsePaymentStatusBody({ order_id: "x" })).toBeNull();
  });
});

describe("fake gateway", () => {
  test("answers the status it recorded, and its notification verifies with the fake key", async () => {
    const provider = createFakePaymentProvider({ baseUrl: "http://localhost:3100" });
    expect(await provider.getPaymentStatus("E2E-ORD-202612-0009-1")).toBeNull();
    const notification = recordFakeTransaction({ providerOrderId: "E2E-ORD-202612-0009-1", transactionStatus: "settlement", grossAmount: 259_000 });
    expect(await provider.getPaymentStatus("E2E-ORD-202612-0009-1")).toMatchObject({ transactionStatus: "settlement", grossAmount: 259_000 });
    expect(
      provider.verifyNotificationSignature({
        orderId: notification.order_id!,
        statusCode: notification.status_code!,
        grossAmount: notification.gross_amount!,
        signatureKey: notification.signature_key!,
      }),
    ).toBe(true);
  });

  test("expires only a pending transaction it recorded, like Midtrans (otherwise null)", async () => {
    const provider = createFakePaymentProvider({ baseUrl: "http://localhost:3100" });
    expect(await provider.expirePayment("E2E-ORD-202612-0010-1")).toBeNull();
    recordFakeTransaction({ providerOrderId: "E2E-ORD-202612-0010-1", transactionStatus: "pending", grossAmount: 259_000 });
    expect(await provider.expirePayment("E2E-ORD-202612-0010-1")).toMatchObject({ transactionStatus: "expire", grossAmount: 259_000 });
    expect(await provider.getPaymentStatus("E2E-ORD-202612-0010-1")).toMatchObject({ transactionStatus: "expire" });
    expect(await provider.expirePayment("E2E-ORD-202612-0010-1")).toBeNull();
    recordFakeTransaction({ providerOrderId: "E2E-ORD-202612-0011-1", transactionStatus: "settlement", grossAmount: 259_000 });
    expect(await provider.expirePayment("E2E-ORD-202612-0011-1")).toBeNull();
  });
});
