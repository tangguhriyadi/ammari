import { describe, expect, test } from "vitest";
import { paymentProviderFromEnv, paymentRuntimeFromEnv } from "./config";
import { createFakePaymentProvider } from "./fake";
import { buildPaymentLines, providerOrderId } from "./lines";
import { PaymentProviderError } from "./provider";
import { fakeMidtransServerKey } from "../../test/fake-keys";

// docs/plans/cart-checkout.md D7, §4.5.6, §12: the pure payment helpers, the fake provider and
// the env runtime. Nothing here reaches a gateway.

// Fake keys with the real prefixes, built at runtime (test/fake-keys.ts): newer sandbox keys share
// production's Mid-server- prefix; only an old-style SB- key is recognisably sandbox.
const SANDBOX_KEY = fakeMidtransServerKey("sandbox");
const LEGACY_SANDBOX_KEY = fakeMidtransServerKey("legacy-sandbox");
const PRODUCTION_KEY = fakeMidtransServerKey("production");

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

  test("midtrans (the default) needs its key and an explicit mode; unknown names are refused", () => {
    const result = paymentRuntimeFromEnv({}, origin);
    expect(result).toEqual({ ok: false, problems: ["MIDTRANS_SERVER_KEY is not set", "MIDTRANS_IS_PRODUCTION must be true or false"] });
    expect(paymentRuntimeFromEnv({ PAYMENT_PROVIDER: "stripe" }, origin).ok).toBe(false);

    const sandbox = paymentRuntimeFromEnv({ MIDTRANS_SERVER_KEY: SANDBOX_KEY, MIDTRANS_IS_PRODUCTION: "false", DEPLOY_ENV: "dev", NODE_ENV: "production" }, origin);
    expect(sandbox.ok && sandbox.runtime.provider.name).toBe("midtrans");
  });

  test("real money only in production: an SB- key or sandbox mode refused there, production mode refused elsewhere", () => {
    const problems = (env: Record<string, string>) => {
      const result = paymentRuntimeFromEnv(env, origin);
      return result.ok ? [] : result.problems;
    };
    // An old-style SB- key in production.
    expect(problems({ MIDTRANS_SERVER_KEY: LEGACY_SANDBOX_KEY, MIDTRANS_IS_PRODUCTION: "true", DEPLOY_ENV: "production" })).toContain(
      "MIDTRANS_SERVER_KEY is a sandbox key but MIDTRANS_IS_PRODUCTION is true",
    );
    // A Mid-server- key cannot be told apart by shape: accepted in sandbox mode on dev (newer sandbox
    // keys) and in production mode in production; a wrong-environment key is Midtrans' 401.
    expect(problems({ MIDTRANS_SERVER_KEY: SANDBOX_KEY, MIDTRANS_IS_PRODUCTION: "false", DEPLOY_ENV: "dev" })).toEqual([]);
    expect(problems({ MIDTRANS_SERVER_KEY: PRODUCTION_KEY, MIDTRANS_IS_PRODUCTION: "false", DEPLOY_ENV: "dev" })).toEqual([]);
    expect(problems({ MIDTRANS_SERVER_KEY: SANDBOX_KEY, MIDTRANS_IS_PRODUCTION: "true", DEPLOY_ENV: "production" })).toEqual([]);
    // Sandbox mode in production, or in a production build that does not name its environment.
    expect(problems({ MIDTRANS_SERVER_KEY: PRODUCTION_KEY, MIDTRANS_IS_PRODUCTION: "false", DEPLOY_ENV: "production" })).toHaveLength(1);
    expect(problems({ MIDTRANS_SERVER_KEY: SANDBOX_KEY, MIDTRANS_IS_PRODUCTION: "false", NODE_ENV: "production" })).toHaveLength(1);
    // Production mode on dev or locally.
    expect(problems({ MIDTRANS_SERVER_KEY: PRODUCTION_KEY, MIDTRANS_IS_PRODUCTION: "true", DEPLOY_ENV: "dev" })).toHaveLength(1);
    expect(problems({ MIDTRANS_SERVER_KEY: PRODUCTION_KEY, MIDTRANS_IS_PRODUCTION: "true", NODE_ENV: "development" })).toHaveLength(1);
    // Production done right.
    expect(problems({ MIDTRANS_SERVER_KEY: PRODUCTION_KEY, MIDTRANS_IS_PRODUCTION: "true", DEPLOY_ENV: "production", NODE_ENV: "production" })).toEqual([]);
    // Names only, never the key.
    expect(problems({ MIDTRANS_SERVER_KEY: LEGACY_SANDBOX_KEY, MIDTRANS_IS_PRODUCTION: "true", DEPLOY_ENV: "production" }).join(" ")).not.toContain(LEGACY_SANDBOX_KEY);
  });

  test("an unknown DEPLOY_ENV fails closed; the notification route's provider ignores checkout timing problems", () => {
    expect(paymentRuntimeFromEnv({ MIDTRANS_SERVER_KEY: SANDBOX_KEY, MIDTRANS_IS_PRODUCTION: "false", DEPLOY_ENV: "prod" }, origin).ok).toBe(false);
    const midtrans = { MIDTRANS_SERVER_KEY: SANDBOX_KEY, MIDTRANS_IS_PRODUCTION: "false", CHECKOUT_PAYMENT_EXPIRY_MINUTES: "nope" };
    expect(paymentRuntimeFromEnv(midtrans, origin).ok).toBe(false);
    const provider = paymentProviderFromEnv(midtrans, origin);
    expect(provider.ok && provider.provider.name).toBe("midtrans");
  });

  test("the notification URL is optional, one https URL", () => {
    const base = { MIDTRANS_SERVER_KEY: SANDBOX_KEY, MIDTRANS_IS_PRODUCTION: "false" };
    expect(paymentRuntimeFromEnv({ ...base, MIDTRANS_NOTIFICATION_URL: "https://ammari.my.id/api/payments/midtrans/notification" }, origin).ok).toBe(true);
    for (const bad of ["http://ammari.my.id/x", "https://a.test/x,https://b.test/y", "not a url", `https://a.test/${"x".repeat(260)}`]) {
      expect(paymentRuntimeFromEnv({ ...base, MIDTRANS_NOTIFICATION_URL: bad }, origin).ok).toBe(false);
    }
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
