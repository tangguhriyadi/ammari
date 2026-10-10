import type { EmailSender } from "./email-sender";

const RESEND_API_URL = "https://api.resend.com/emails";

export interface ResendEmailSenderOptions {
  apiKey: string;
  /** Resend requires a verified sending domain — e.g. "Ammari <noreply@ammari.id>" or a bare
   * address. Passed straight through as the request's "from" field. */
  from: string;
}

/** Calls Resend's REST API directly via `fetch` rather than depending on its SDK — the API
 * surface this needs is one POST request, and this package otherwise has zero HTTP-client
 * dependencies; pulling in a whole SDK for one endpoint isn't worth it. Usable by both apps/web
 * and apps/admin (both select it the same way: RESEND_API_KEY + EMAIL_FROM set). */
export class ResendEmailSender implements EmailSender {
  constructor(private readonly options: ResendEmailSenderOptions) {}

  async send(params: { to: string; subject: string; body: string }): Promise<void> {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.options.from,
        to: [params.to],
        subject: params.subject,
        text: params.body,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`Resend email send failed (${response.status}): ${errorBody}`);
    }
  }
}
