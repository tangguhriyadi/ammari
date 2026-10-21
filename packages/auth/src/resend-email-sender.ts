import type { EmailMessage, EmailSender } from "./email-sender";

const RESEND_API_URL = "https://api.resend.com/emails";
/** One send never hangs a caller (an `after()` callback, a cron pass) for longer than this. */
const RESEND_TIMEOUT_MS = 10_000;

export interface ResendEmailSenderOptions {
  apiKey: string;
  /** Resend requires a verified sending domain — e.g. "Ammari <noreply@ammari.id>" or a bare
   * address. Passed straight through as the request's "from" field. */
  from: string;
}

/** A failed send. The message carries only the HTTP status and Resend's error name (e.g.
 * `validation_error`, `rate_limit_exceeded`), never the response body, which can echo the
 * recipient's address: callers store and log this message. */
export class EmailDeliveryError extends Error {
  constructor(
    /** The HTTP status, or null when no answer arrived (network error, timeout). */
    readonly status: number | null,
    /** Resend's error `name`, when the body had one. */
    readonly providerError: string | null,
  ) {
    super(`email send failed (${status ?? "no answer"}${providerError ? `, ${providerError}` : ""})`);
    this.name = "EmailDeliveryError";
  }
}

/** Resend's error `name` (a short identifier), when the body is its JSON error shape. */
function providerErrorName(body: string): string | null {
  try {
    const name = (JSON.parse(body) as { name?: unknown }).name;
    return typeof name === "string" && /^[a-z_]{1,60}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** Calls Resend's REST API directly via `fetch` rather than depending on its SDK — the API
 * surface this needs is one POST request, and this package otherwise has zero HTTP-client
 * dependencies; pulling in a whole SDK for one endpoint isn't worth it. Usable by both apps/web
 * and apps/admin (both select it the same way: RESEND_API_KEY + EMAIL_FROM set). */
export class ResendEmailSender implements EmailSender {
  constructor(private readonly options: ResendEmailSenderOptions) {}

  async send(params: EmailMessage): Promise<void> {
    let response: Response;
    try {
      response = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          ...(params.idempotencyKey ? { "Idempotency-Key": params.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [params.to],
          subject: params.subject,
          text: params.body,
          ...(params.html ? { html: params.html } : {}),
        }),
        redirect: "error",
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
    } catch (error) {
      throw new EmailDeliveryError(null, error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_error");
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new EmailDeliveryError(response.status, providerErrorName(errorBody));
    }
  }
}
