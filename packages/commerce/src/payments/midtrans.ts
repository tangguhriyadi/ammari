import "server-only";
import { z } from "zod";
import {
  PAYMENT_STATUS_TIMEOUT_MS,
  PaymentProviderError,
  type CreatePaymentInput,
  type CreatedPayment,
  type GetPaymentStatusOptions,
  type NotificationSignatureFields,
  type PaymentProvider,
  type PaymentStatusReport,
} from "./provider";
import { parsePaymentStatusBody, verifyMidtransSignature } from "./status";

// Midtrans Snap (redirect mode, D5) and the status API (D6). From the public docs, read
// 2026-10-21:
// - Snap: `POST https://app(.sandbox).midtrans.com/snap/v1/transactions`, HTTP Basic with the
//   server key as user and an empty password, JSON. 201 `{ token, redirect_url }`; errors 400 /
//   401 / 500 with `error_messages[]`; a used order_id answers 406 (one Midtrans order id per
//   attempt, D7). https://docs.midtrans.com/reference/backend-integration ,
//   https://docs.midtrans.com/reference/status-code-4xx
// - Body: `transaction_details { order_id (max 50, A-Za-z0-9 - _ ~ .), gross_amount }`,
//   `item_details [{ id, price, quantity, name (max 50) }]` summing exactly to gross_amount
//   (negative price allowed for a discount), `customer_details`, `enabled_payments`,
//   `callbacks.finish`, `expiry { start_time "yyyy-MM-dd HH:mm:ss Z", unit, duration }`. Without
//   `start_time` the window of an async method (VA, e-wallet) starts only when the buyer picks it,
//   so it is always sent. `page_expiry { duration, unit }` ends the Snap page itself (default 24 h
//   for token and page; read 2026-10-21). BCA VA refuses first_name + last_name over 30 characters.
//   https://docs.midtrans.com/reference/json-objects , https://docs.midtrans.com/docs/snap-advanced-feature
// - `enabled_payments` codes: `other_qris`, `gopay`, `shopeepay`, `bca_va`, `bni_va`, `bri_va`,
//   `echannel` (Mandiri bill), `permata_va`. https://docs.midtrans.com/reference/request-body-json-parameter
// - `X-Override-Notification: <url>` on the create request replaces the dashboard notification
//   URL for that transaction (D8). https://docs.midtrans.com/docs/https-notification-webhooks
// - Status: `GET https://api(.sandbox).midtrans.com/v2/{order_id}/status`, same auth.
//   https://docs.midtrans.com/reference/get-transaction-status
// - Expire (read 2026-10-21, for the expiry sweep): `POST https://api(.sandbox).midtrans.com/v2/
//   {order_id}/expire`, same auth, no body. Success is HTTP 200 with `status_code` "407" and
//   `transaction_status` "expire" plus the usual transaction fields; 412 "Merchant cannot modify
//   the status of the transaction" when it is no longer pending; 401 for a key that does not
//   match. https://docs.midtrans.com/reference/expire-transaction
// The hosts are constants chosen by MIDTRANS_IS_PRODUCTION, never configuration or input (no SSRF).

/** Owner decision 2: exactly these methods, no cards (D16). */
export const MIDTRANS_ENABLED_PAYMENTS = ["other_qris", "gopay", "shopeepay", "bca_va", "bni_va", "bri_va", "echannel", "permata_va"] as const;

export const MIDTRANS_HOSTS = {
  sandbox: { snap: "https://app.sandbox.midtrans.com", api: "https://api.sandbox.midtrans.com" },
  production: { snap: "https://app.midtrans.com", api: "https://api.midtrans.com" },
} as const;

/** Snap creation runs in the buyer's request; placeOrder's own cap (15 s) usually ends it first. */
export const MIDTRANS_CREATE_TIMEOUT_MS = 15_000;
export const MIDTRANS_RETRY_DELAY_MS = 300;

/** BCA VA's limit on the customer name (json-objects docs). */
const CUSTOMER_NAME_MAX = 30;

export interface MidtransProviderOptions {
  serverKey: string;
  isProduction: boolean;
  /** `MIDTRANS_NOTIFICATION_URL`, sent as X-Override-Notification (D8); already validated. */
  notificationUrl: string | null;
  fetch?: typeof fetch;
  now?: () => Date;
  createTimeoutMs?: number;
  statusTimeoutMs?: number;
  retryDelayMs?: number;
}

const createdBody = z.object({ token: z.string().trim().min(1).max(200), redirect_url: z.string().trim().min(1).max(2_000) });

/** "2026-10-21 14:30:00 +0700": the Snap `expiry.start_time` format, in Jakarta time. */
export function midtransStartTime(at: Date): string {
  const jakarta = new Date(at.getTime() + 7 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${jakarta.getUTCFullYear()}-${pad(jakarta.getUTCMonth() + 1)}-${pad(jakarta.getUTCDate())} ${pad(jakarta.getUTCHours())}:${pad(jakarta.getUTCMinutes())}:${pad(jakarta.getUTCSeconds())} +0700`;
}

function cutName(name: string): string {
  const chars = Array.from(name.trim());
  return chars.length <= CUSTOMER_NAME_MAX ? chars.join("") : chars.slice(0, CUSTOMER_NAME_MAX).join("").trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One signal that aborts when either the caller's or our own timeout does. */
function combinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export function createMidtransPaymentProvider(options: MidtransProviderOptions): PaymentProvider {
  const hosts = options.isProduction ? MIDTRANS_HOSTS.production : MIDTRANS_HOSTS.sandbox;
  const snapHost = new URL(hosts.snap).host;
  const authorization = `Basic ${Buffer.from(`${options.serverKey}:`, "utf8").toString("base64")}`;
  const fetchFn = () => options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  /** One call to the Core API (`/v2/{order_id}/<action>`): 5 s, one retry on a network error or a
   * 5xx, never after a timeout or the caller's abort (the caller has already waited). The body is
   * parsed as JSON when it is JSON, otherwise null. */
  async function apiRequest(method: "GET" | "POST", providerOrderId: string, action: "status" | "expire", requestOptions: GetPaymentStatusOptions): Promise<{ response: Response; json: unknown }> {
    const url = `${hosts.api}/v2/${encodeURIComponent(providerOrderId)}/${action}`;
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetchFn()(url, {
          method,
          headers: { authorization, accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
          signal: combinedSignal(options.statusTimeoutMs ?? PAYMENT_STATUS_TIMEOUT_MS, requestOptions.signal),
          cache: "no-store",
          redirect: "error",
        });
      } catch (error) {
        const aborted = isAbort(error) || requestOptions.signal?.aborted === true;
        if (!aborted && attempt === 1) {
          await delay(options.retryDelayMs ?? MIDTRANS_RETRY_DELAY_MS);
          continue;
        }
        throw new PaymentProviderError("unavailable", aborted ? `Midtrans ${action} request timed out` : `Midtrans ${action} request failed`, { cause: error });
      }
      if (response.status >= 500 && attempt === 1 && requestOptions.signal?.aborted !== true) {
        await response.body?.cancel();
        await delay(options.retryDelayMs ?? MIDTRANS_RETRY_DELAY_MS);
        continue;
      }
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      return { response, json };
    }
  }

  function reportFor(providerOrderId: string, json: unknown, httpStatus: number, action: "status" | "expire"): PaymentStatusReport {
    const report = parsePaymentStatusBody(json);
    if (!report) throw new PaymentProviderError("bad_response", `Midtrans ${action} answered an unexpected shape`, { status: httpStatus });
    if (report.providerOrderId !== providerOrderId) throw new PaymentProviderError("bad_response", `Midtrans ${action} answered for another order id`, { status: httpStatus });
    return report;
  }

  return {
    name: "midtrans",

    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      const headers: Record<string, string> = {
        authorization,
        accept: "application/json",
        "content-type": "application/json",
      };
      if (options.notificationUrl) headers["x-override-notification"] = options.notificationUrl;
      const body = {
        transaction_details: { order_id: input.providerOrderId, gross_amount: input.grossAmount },
        item_details: input.lines.map((line) => ({ id: line.id, price: line.price, quantity: line.quantity, name: line.name })),
        customer_details: { first_name: cutName(input.customer.name), email: input.customer.email, phone: input.customer.phone },
        enabled_payments: [...MIDTRANS_ENABLED_PAYMENTS],
        callbacks: { finish: input.finishUrl },
        expiry: { start_time: midtransStartTime(now()), unit: "minute", duration: input.expiryMinutes },
        // The page itself lives 24 hours by default; it ends with the payment window, so a buyer can
        // never start a payment on an order the expiry sweep has already ended (session 12).
        page_expiry: { duration: input.expiryMinutes, unit: "minute" },
      };

      // Never retried: a second create with the same order id is refused (406) anyway, and the
      // buyer is waiting. A failure leaves the order pending; the finish page retries with a new
      // attempt (./attempts.ts).
      let response: Response;
      try {
        response = await fetchFn()(`${hosts.snap}/snap/v1/transactions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: combinedSignal(options.createTimeoutMs ?? MIDTRANS_CREATE_TIMEOUT_MS, input.signal),
          cache: "no-store",
          redirect: "error",
        });
      } catch (error) {
        throw new PaymentProviderError("unavailable", isAbort(error) ? "Midtrans Snap request timed out" : "Midtrans Snap request failed", { cause: error });
      }

      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      if (response.status !== 201 && response.status !== 200) {
        // error_messages may echo our request (the buyer's email); only their count is logged.
        const messages = (json as { error_messages?: unknown } | null)?.error_messages;
        const count = Array.isArray(messages) ? messages.length : 0;
        throw new PaymentProviderError("unavailable", `Midtrans Snap answered ${response.status} (${count} error messages)`, { status: response.status });
      }
      const created = createdBody.safeParse(json);
      if (!created.success) throw new PaymentProviderError("bad_response", "Midtrans Snap answered without a token and redirect URL", { status: response.status });

      // The buyer is sent to this URL: only Snap's own https host for this mode (session 10 note).
      let redirect: URL;
      try {
        redirect = new URL(created.data.redirect_url);
      } catch {
        throw new PaymentProviderError("bad_response", "Midtrans Snap redirect URL is not a URL", { status: response.status });
      }
      if (redirect.protocol !== "https:" || redirect.host !== snapHost) {
        throw new PaymentProviderError("bad_response", "Midtrans Snap redirect URL is not on the Snap host", { status: response.status });
      }
      return { token: created.data.token, redirectUrl: redirect.toString() };
    },

    async getPaymentStatus(providerOrderId: string, statusOptions: GetPaymentStatusOptions = {}): Promise<PaymentStatusReport | null> {
      const { response, json } = await apiRequest("GET", providerOrderId, "status", statusOptions);
      const bodyCode = (json as { status_code?: unknown } | null)?.status_code;
      if (response.status === 404 || bodyCode === "404") return null;
      if (response.status !== 200) throw new PaymentProviderError("unavailable", `Midtrans status answered ${response.status}`, { status: response.status });
      // The API answers HTTP 200 with its own status_code; a 401/5xx in the body is a key or
      // gateway problem, never a transaction state.
      if (typeof bodyCode === "string" && /^(401|403|5[0-9]{2})$/.test(bodyCode)) {
        throw new PaymentProviderError("unavailable", `Midtrans status answered status_code ${bodyCode}`, { status: response.status });
      }
      return reportFor(providerOrderId, json, response.status, "status");
    },

    async expirePayment(providerOrderId: string, expireOptions: GetPaymentStatusOptions = {}): Promise<PaymentStatusReport | null> {
      const { response, json } = await apiRequest("POST", providerOrderId, "expire", expireOptions);
      const bodyCode = (json as { status_code?: unknown } | null)?.status_code;
      // 404: no transaction for the id (the buyer never picked a method); 412: "Merchant cannot
      // modify the status of the transaction" (no longer pending: paid, expired or cancelled in
      // the meantime). Either way the caller re-reads the status.
      if (response.status === 404 || response.status === 412 || bodyCode === "404" || bodyCode === "412") return null;
      if (response.status !== 200) throw new PaymentProviderError("unavailable", `Midtrans expire answered ${response.status}`, { status: response.status });
      if (bodyCode !== "407") throw new PaymentProviderError(typeof bodyCode === "string" && /^(401|403|5[0-9]{2})$/.test(bodyCode) ? "unavailable" : "bad_response", `Midtrans expire answered status_code ${typeof bodyCode === "string" ? bodyCode.slice(0, 8) : typeof bodyCode}`, { status: response.status });
      return reportFor(providerOrderId, json, response.status, "expire");
    },

    verifyNotificationSignature(fields: NotificationSignatureFields): boolean {
      return verifyMidtransSignature(fields, options.serverKey);
    },
  };
}
