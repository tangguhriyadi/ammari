// The payment seam (docs/plans/cart-checkout.md D5, D7, §5 step 11): Midtrans Snap in production
// (session 11), FakePaymentProvider in tests and e2e. placeOrder calls it once, after its order
// transaction commits (never inside it), and stores the token and redirect URL on the payment
// attempt. "Paid" is never decided here: only the verified notification plus a status re-fetch
// does that (D6, session 11).

/** One line of the amount the gateway charges (Midtrans `item_details`, plan §4.5.6). Prices are
 * whole rupiah; the voucher is a negative line. The lines always sum to the attempt's gross amount
 * (`buildPaymentLines` checks it). */
export interface PaymentLine {
  id: string;
  name: string;
  /** Whole rupiah per unit; negative only for the voucher line. */
  price: number;
  quantity: number;
}

export interface CreatePaymentInput {
  /** `payments.provider_order_id`: `<prefix><order_no>-<attempt>` (D7). */
  providerOrderId: string;
  grossAmount: number;
  lines: readonly PaymentLine[];
  /** What the gateway shows on its own page; the buyer's contact as typed at checkout. */
  customer: { name: string; email: string; phone: string };
  /** The payment window (owner decision 1: 60 minutes). */
  expiryMinutes: number;
  /** Where the gateway sends the buyer back (`/checkout/finish?order=<orderNo>`, plan §4.4). */
  finishUrl: string;
  /** Aborted when placeOrder stops waiting (PAYMENT_PAGE_TIMEOUT_MS); a real client passes it to
   * fetch. */
  signal?: AbortSignal;
}

export interface CreatedPayment {
  /** Midtrans Snap token. */
  token: string;
  /** The gateway's payment page (Snap redirect mode, D5). */
  redirectUrl: string;
}

/** `unavailable`: network, timeout, 5xx, or a key/config problem; `bad_response`: the answer did
 * not have the documented shape. Either way the order stays pending without a payment page, and
 * the buyer can retry from the finish page (plan §5 step 11). */
export type PaymentProviderErrorReason = "unavailable" | "bad_response";

export class PaymentProviderError extends Error {
  readonly reason: PaymentProviderErrorReason;
  readonly status: number | undefined;

  constructor(reason: PaymentProviderErrorReason, message: string, details: { status?: number; cause?: unknown } = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "PaymentProviderError";
    this.reason = reason;
    this.status = details.status;
  }

  /** Safe to log: reason, status and our own message; the cause by name and code only (e.g.
   * ECONNRESET; never a key, body or signature). */
  logFields(): Record<string, unknown> {
    const cause = this.cause;
    const causeSummary =
      cause instanceof Error
        ? { name: cause.name, code: (cause as { code?: unknown }).code ?? (cause.cause as { code?: unknown } | undefined)?.code }
        : undefined;
    return { reason: this.reason, status: this.status, message: this.message, cause: causeSummary };
  }
}

export interface PaymentProvider {
  readonly name: "midtrans" | "fake";
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
}
