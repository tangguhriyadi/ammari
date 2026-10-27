export interface EmailMessage {
  to: string;
  subject: string;
  /** The plain-text part (always sent). */
  body: string;
  /** The HTML part (docs/plans/email-design.md): every Ammari email has one; optional only so a
   * text-only message stays expressible. */
  html?: string;
  /** Sent as the provider's idempotency key, so a retried send of the same message is delivered
   * once (Resend keeps a key for 24 hours). */
  idempotencyKey?: string;
}

export interface EmailSender {
  send(params: EmailMessage): Promise<void>;
}

/** Local dev: prints the email to the server console instead of delivering it. A real provider
 * (SES/Resend/etc.) is added later — see docs/SPEC.md's Pre-deploy checklist. */
export class ConsoleEmailSender implements EmailSender {
  async send(params: EmailMessage): Promise<void> {
    console.log(`[email] to=${params.to} subject="${params.subject}"\n${params.body}`);
  }
}

/** Production without a configured provider must fail loudly, not silently drop emails. */
export class UnconfiguredEmailSender implements EmailSender {
  async send(params: EmailMessage): Promise<void> {
    throw new Error(
      `No EmailSender is configured for production — cannot send "${params.subject}" to ${params.to}. ` +
        `Wire up a real provider before deploying (see docs/SPEC.md's Pre-deploy checklist).`,
    );
  }
}
