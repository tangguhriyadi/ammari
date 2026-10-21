// The payment seam (docs/plans/cart-checkout.md D5, D7, §5 step 11, §6): Midtrans Snap
// (./midtrans.ts) when configured, FakePaymentProvider in tests and e2e. placeOrder (and the
// finish page's retry, ./attempts.ts) asks it for a payment page after the order transaction
// commits (never inside it). "Paid" is never decided by a provider call either: only a notification
// whose signature verifies, followed by a server-to-server status fetch, or that status fetch
// alone on the finish page, feeds the one state machine (./apply-status.ts, D6).

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
  /** The gateway refused the server key (401): not configured, or a key for the other environment.
   * Always `unavailable`, so checkout fails closed; flagged so the log says what to fix. */
  readonly keyRejected: boolean;

  constructor(reason: PaymentProviderErrorReason, message: string, details: { status?: number; cause?: unknown; keyRejected?: boolean } = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "PaymentProviderError";
    this.reason = reason;
    this.status = details.status;
    this.keyRejected = details.keyRejected === true;
  }

  /** Safe to log: reason, status and our own message; the cause by name and code only (e.g.
   * ECONNRESET; never a key, body or signature). */
  logFields(): Record<string, unknown> {
    const cause = this.cause;
    const causeSummary =
      cause instanceof Error
        ? { name: cause.name, code: (cause as { code?: unknown }).code ?? (cause.cause as { code?: unknown } | undefined)?.code }
        : undefined;
    return { reason: this.reason, status: this.status, message: this.message, ...(this.keyRejected ? { keyRejected: true } : {}), cause: causeSummary };
  }
}

/** The signed fields of a payment notification, exactly as received (strings, `gross_amount` with
 * its ".00"). */
export interface NotificationSignatureFields {
  orderId: string;
  statusCode: string;
  grossAmount: string;
  signatureKey: string;
}

/** What the gateway's status API says about one attempt, parsed (./status.ts). Only this, never a
 * notification body, decides what happens to an order. */
export interface PaymentStatusReport {
  providerOrderId: string;
  /** Raw `transaction_status` (lower case); an unknown value is kept and flagged, never guessed. */
  transactionStatus: string;
  /** Midtrans `transaction_id` (`payments.provider_ref`). */
  transactionId: string | null;
  paymentType: string | null;
  /** `gross_amount` in whole rupiah; null when it is missing or has a non-zero fraction. */
  grossAmount: number | null;
  currency: string | null;
  fraudStatus: string | null;
  /** `refund_amount` in whole rupiah, when the gateway reports one. */
  refundAmount: number | null;
  /** The allowlisted fields stored in `payments.last_status` (no signature, no key). */
  snapshot: Record<string, string | null>;
}

/** A status fetch (or an expire call) answers a notification (Midtrans waits 15 s and asks for
 * about 5 s), the finish page or the expiry sweep. */
export const PAYMENT_STATUS_TIMEOUT_MS = 5_000;

export interface GetPaymentStatusOptions {
  signal?: AbortSignal;
}

export interface PaymentProvider {
  readonly name: "midtrans" | "fake";
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  /** The attempt's current status from the gateway (server to server), or null when the gateway
   * has no transaction for it yet (the buyer never picked a method). Throws PaymentProviderError
   * when the gateway cannot be asked. */
  getPaymentStatus(providerOrderId: string, options?: GetPaymentStatusOptions): Promise<PaymentStatusReport | null>;
  /** Asks the gateway to end a still pending attempt (Midtrans `POST /v2/{order_id}/expire`), for
   * the expiry sweep (./sweep.ts), a staff cancel (./staff.ts) and the buyer's "Ganti metode
   * pembayaran" (./attempts.ts) only. Returns the gateway's answer as a status report, or null
   * when it refused because there is nothing to expire (no transaction yet, or the transaction is
   * no longer pending): the caller then fetches the status again. Throws PaymentProviderError when
   * the gateway cannot be asked. Never decides anything itself: the report goes through the state
   * machine like any fetched status. */
  expirePayment(providerOrderId: string, options?: GetPaymentStatusOptions): Promise<PaymentStatusReport | null>;
  /** Constant-time check of a notification's `signature_key` with this provider's server key. */
  verifyNotificationSignature(fields: NotificationSignatureFields): boolean;
}
