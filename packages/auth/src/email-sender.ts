export interface EmailSender {
  send(params: { to: string; subject: string; body: string }): Promise<void>;
}

/** Local dev: prints the email to the server console instead of delivering it. A real provider
 * (SES/Resend/etc.) is added later — see docs/SPEC.md's Pre-deploy checklist. */
export class ConsoleEmailSender implements EmailSender {
  async send(params: { to: string; subject: string; body: string }): Promise<void> {
    console.log(`[email] to=${params.to} subject="${params.subject}"\n${params.body}`);
  }
}

/** Production without a configured provider must fail loudly, not silently drop emails. */
export class UnconfiguredEmailSender implements EmailSender {
  async send(params: { to: string; subject: string }): Promise<void> {
    throw new Error(
      `No EmailSender is configured for production — cannot send "${params.subject}" to ${params.to}. ` +
        `Wire up a real provider before deploying (see docs/SPEC.md's Pre-deploy checklist).`,
    );
  }
}
