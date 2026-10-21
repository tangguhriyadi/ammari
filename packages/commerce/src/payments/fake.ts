import { createHash } from "node:crypto";
import { PaymentProviderError, type CreatePaymentInput, type CreatedPayment, type PaymentProvider } from "./provider";

// FakePaymentProvider (docs/plans/cart-checkout.md §13): stands in for Midtrans Snap in unit tests
// and e2e, selected by PAYMENT_PROVIDER=fake behind the e2e fixtures gate (./config.ts). Never
// calls anything. The redirect URL points at a gated, read-only local "Snap" page under /api/test/
// (apps/web app/api/test/payments/[providerOrderId], session 10).

/** The local fake payment page, relative to the storefront origin. */
export const FAKE_PAYMENT_PAGE_PATH = "/api/test/payments";

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
  };
}
