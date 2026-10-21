import { createHash } from "node:crypto";
import { PaymentProviderError, type CreatePaymentInput, type CreatedPayment, type PaymentProvider, type PaymentStatusReport } from "./provider";
import { midtransSignature, parsePaymentStatusBody, verifyMidtransSignature } from "./status";

// FakePaymentProvider (docs/plans/cart-checkout.md §13): stands in for Midtrans Snap in unit tests
// and e2e, selected by PAYMENT_PROVIDER=fake behind the e2e fixtures gate (./config.ts). Never
// calls anything. The redirect URL points at a gated local "Snap" page under /api/test/ (apps/web
// app/api/test/payments/[providerOrderId]); its test buttons record what the fake gateway "knows"
// about an attempt here and send a notification signed with FAKE_PAYMENT_SERVER_KEY through the
// real notification route, which then asks this fake for the status like it asks Midtrans.

/** The local fake payment page, relative to the storefront origin. */
export const FAKE_PAYMENT_PAGE_PATH = "/api/test/payments";

/** The fake gateway's "server key": signs and verifies the e2e notifications. Not a secret (the
 * fake only runs in a non-production build with E2E_TEST_LOGIN=true). */
export const FAKE_PAYMENT_SERVER_KEY = "fake-payment-server-key";

/** The fake gateway's state per provider order id: the status body it answers. Kept on globalThis
 * so every route bundle of one dev server process sees the same map. */
const STORE_KEY = Symbol.for("ammari.fakePaymentGateway");
type FakeStore = Map<string, Record<string, string>>;

function fakeStore(): FakeStore {
  const holder = globalThis as typeof globalThis & { [STORE_KEY]?: FakeStore };
  holder[STORE_KEY] ??= new Map();
  return holder[STORE_KEY];
}

export interface FakeTransactionInput {
  providerOrderId: string;
  transactionStatus: "pending" | "settlement" | "expire" | "cancel" | "deny";
  grossAmount: number;
  paymentType?: string;
}

/** Status codes Midtrans uses with each status (https-notification-webhooks samples). */
const FAKE_STATUS_CODES: Record<FakeTransactionInput["transactionStatus"], string> = {
  pending: "201",
  settlement: "200",
  expire: "407",
  cancel: "200",
  deny: "202",
};

/** Records the fake gateway's answer for an attempt and returns the signed notification body the
 * real gateway would send for it (e2e only). */
export function recordFakeTransaction(input: FakeTransactionInput): Record<string, string> {
  const grossAmount = `${input.grossAmount}.00`;
  const statusCode = FAKE_STATUS_CODES[input.transactionStatus];
  const body: Record<string, string> = {
    order_id: input.providerOrderId,
    transaction_status: input.transactionStatus,
    status_code: statusCode,
    gross_amount: grossAmount,
    currency: "IDR",
    payment_type: input.paymentType ?? "qris",
    transaction_id: `fake-${createHash("sha256").update(input.providerOrderId).digest("hex").slice(0, 32)}`,
    transaction_time: "2026-12-01 10:00:00",
    fraud_status: "accept",
  };
  fakeStore().set(input.providerOrderId, body);
  return { ...body, signature_key: midtransSignature({ orderId: input.providerOrderId, statusCode, grossAmount }, FAKE_PAYMENT_SERVER_KEY) };
}

export interface FakePaymentProviderOptions {
  /** The storefront origin the fake page lives on, no trailing slash. */
  baseUrl: string;
  /** Makes every createPayment call fail like a gateway outage (tests of the "Snap failed" path). */
  failWith?: PaymentProviderError["reason"];
}

export function createFakePaymentProvider(options: FakePaymentProviderOptions): PaymentProvider {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return {
    name: "fake",
    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      if (options.failWith) throw new PaymentProviderError(options.failWith, "fake payment provider outage");
      // Deterministic per attempt, like a real token is stable for its order id.
      const token = `fake-${createHash("sha256").update(input.providerOrderId).digest("hex").slice(0, 32)}`;
      return { token, redirectUrl: `${baseUrl}${FAKE_PAYMENT_PAGE_PATH}/${encodeURIComponent(input.providerOrderId)}` };
    },
    async getPaymentStatus(providerOrderId: string): Promise<PaymentStatusReport | null> {
      const body = fakeStore().get(providerOrderId);
      return body ? parsePaymentStatusBody(body) : null;
    },
    verifyNotificationSignature(fields) {
      return verifyMidtransSignature(fields, FAKE_PAYMENT_SERVER_KEY);
    },
  };
}
