import { describe, expect, test } from "vitest";
import { paymentRuntimeFromEnv } from "./config";
import { createFakePaymentProvider } from "./fake";
import { buildPaymentLines, providerOrderId } from "./lines";
import { PaymentProviderError } from "./provider";

// docs/plans/cart-checkout.md D7, §4.5.6, §12, session 9: the pure payment helpers, the fake
// provider and the env runtime. Nothing here reaches a gateway.

const product = { sku: "GB-BLK-M", name: "Gamis Basic Black M", unitPrice: 259_000, qty: 2 };

describe("buildPaymentLines", () => {
  test("products only when the buyer pays no ongkir and has no voucher", () => {
    expect(buildPaymentLines({ products: [product], shippingAmount: 0, discountAmount: 0, grossAmount: 518_000 })).toEqual([
      { id: "GB-BLK-M", name: "Gamis Basic Black M", price: 259_000, quantity: 2 },
    ]);
  });

  test("an Ongkir line only when the buyer's share is above 0, then a negative Voucher line; they sum to the gross amount", () => {
    const lines = buildPaymentLines({ products: [product], shippingAmount: 75_000, discountAmount: 20_000, grossAmount: 573_000 });
    expect(lines).toEqual([
      { id: "GB-BLK-M", name: "Gamis Basic Black M", price: 259_000, quantity: 2 },
      { id: "SHIPPING", name: "Ongkir", price: 75_000, quantity: 1 },
      { id: "VOUCHER", name: "Voucher", price: -20_000, quantity: 1 },
    ]);
    expect(lines.reduce((sum, line) => sum + line.price * line.quantity, 0)).toBe(573_000);
  });

  test("refuses lines that do not sum to the gross amount, fractional rupiah and empty orders", () => {
    expect(() => buildPaymentLines({ products: [product], shippingAmount: 0, discountAmount: 0, grossAmount: 518_001 })).toThrow(RangeError);
    expect(() => buildPaymentLines({ products: [{ ...product, unitPrice: 1.5 }], shippingAmount: 0, discountAmount: 0, grossAmount: 3 })).toThrow(RangeError);
    expect(() => buildPaymentLines({ products: [], shippingAmount: 0, discountAmount: 0, grossAmount: 1 })).toThrow(RangeError);
    expect(() => buildPaymentLines({ products: [product], shippingAmount: -1, discountAmount: 0, grossAmount: 517_999 })).toThrow(RangeError);
  });

  test("item names are cut to 50 characters", () => {
    const [line] = buildPaymentLines({ products: [{ ...product, qty: 1, name: "x".repeat(80) }], shippingAmount: 0, discountAmount: 0, grossAmount: 259_000 });
    expect(line?.name).toHaveLength(50);
  });
});

describe("providerOrderId", () => {
  test("<prefix><order_no>-<attempt>", () => {
    expect(providerOrderId("", "ORD-202612-0001", 1)).toBe("ORD-202612-0001-1");
    expect(providerOrderId("DEV-", "ORD-202612-0042", 3)).toBe("DEV-ORD-202612-0042-3");
  });

  test("refuses a bad prefix, a non-order number or attempt", () => {
    expect(() => providerOrderId("dev ", "ORD-202612-0001", 1)).toThrow(RangeError);
    expect(() => providerOrderId("", "../x", 1)).toThrow(RangeError);
    expect(() => providerOrderId("", "ORD-202612-0001", 0)).toThrow(RangeError);
  });
});

describe("createFakePaymentProvider", () => {
  const input = {
    providerOrderId: "LOCAL-ORD-202612-0001-1",
    grossAmount: 259_000,
    lines: [],
    customer: { name: "Siti", email: "siti@example.com", phone: "+6281234567890" },
    expiryMinutes: 60,
    finishUrl: "http://localhost:3000/checkout/finish?order=ORD-202612-0001",
  };

  test("answers a stable token and a local redirect URL", async () => {
    const provider = createFakePaymentProvider({ baseUrl: "http://localhost:3000/" });
    const first = await provider.createPayment(input);
    expect(first.redirectUrl).toBe("http://localhost:3000/api/test/payments/LOCAL-ORD-202612-0001-1");
    expect(first.token).toMatch(/^fake-[0-9a-f]{32}$/);
    expect((await provider.createPayment(input)).token).toBe(first.token);
  });

  test("can fail like an outage", async () => {
    const provider = createFakePaymentProvider({ baseUrl: "http://localhost:3000", failWith: "unavailable" });
    await expect(provider.createPayment(input)).rejects.toBeInstanceOf(PaymentProviderError);
  });
});

describe("paymentRuntimeFromEnv", () => {
  const origin = { siteOrigin: "http://localhost:3000" };

  test("the fake only in an e2e run, with the default timing", () => {
    const result = paymentRuntimeFromEnv({ PAYMENT_PROVIDER: "fake", E2E_TEST_LOGIN: "true", NODE_ENV: "test" }, origin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runtime.provider.name).toBe("fake");
    expect(result.runtime).toMatchObject({ orderIdPrefix: "", paymentExpiryMinutes: 60, stockHoldMinutes: 75 });
  });

  test("the fake is refused in a production build or without the e2e gate", () => {
    expect(paymentRuntimeFromEnv({ PAYMENT_PROVIDER: "fake", E2E_TEST_LOGIN: "true", NODE_ENV: "production" }, origin).ok).toBe(false);
    expect(paymentRuntimeFromEnv({ PAYMENT_PROVIDER: "fake", NODE_ENV: "test" }, origin).ok).toBe(false);
  });

  test("midtrans (the default) is not configured until session 11; unknown names are refused", () => {
    const result = paymentRuntimeFromEnv({}, origin);
    expect(result).toEqual({ ok: false, problems: ["PAYMENT_PROVIDER=midtrans is not available yet (plan session 11)"] });
    expect(paymentRuntimeFromEnv({ PAYMENT_PROVIDER: "stripe" }, origin).ok).toBe(false);
  });

  test("timing and prefix are validated; the hold must outlast the payment window", () => {
    const gate = { PAYMENT_PROVIDER: "fake", E2E_TEST_LOGIN: "true", NODE_ENV: "test" };
    const ok = paymentRuntimeFromEnv({ ...gate, CHECKOUT_PAYMENT_EXPIRY_MINUTES: "30", CHECKOUT_STOCK_HOLD_MINUTES: "45", MIDTRANS_ORDER_ID_PREFIX: "LOCAL-" }, origin);
    expect(ok.ok && ok.runtime).toMatchObject({ paymentExpiryMinutes: 30, stockHoldMinutes: 45, orderIdPrefix: "LOCAL-" });

    for (const bad of [
      { CHECKOUT_PAYMENT_EXPIRY_MINUTES: "60", CHECKOUT_STOCK_HOLD_MINUTES: "60" },
      { CHECKOUT_PAYMENT_EXPIRY_MINUTES: "1e3" },
      { CHECKOUT_STOCK_HOLD_MINUTES: "0" },
      { MIDTRANS_ORDER_ID_PREFIX: "dev_" },
    ]) {
      const result = paymentRuntimeFromEnv({ ...gate, ...bad }, origin);
      expect(result.ok).toBe(false);
      // Variable names only, never values.
      if (!result.ok) expect(result.problems.join(" ")).not.toMatch(/1e3|dev_/);
    }
  });
});
