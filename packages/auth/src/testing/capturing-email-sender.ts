import type { EmailSender } from "../email-sender";

/** Test-only. `send()` is a no-op (it never actually delivers the email) — the OTP itself is
 * captured separately via `capture()`, wired to `createStaffAuth`'s `onOtpGenerated` hook, which
 * hands the OTP over as a structured value rather than this class having to parse it back out of
 * the rendered email body (that would couple it to free-text copy owned by a different file).
 * Lets an e2e test sign in through the real Better Auth code path (hooks, rate limiting, cookie
 * issuance all run unmodified) and only skip the "read an email inbox" step. Never selected
 * unless the caller's own environment checks (see apps/admin/src/lib/auth/staff.ts and
 * app/api/test/login/route.ts) decide to use it — this class has no gate of its own, by design:
 * it holds no secrets and does nothing harmful if merely imported, so the gating responsibility
 * stays entirely with the two call sites that are actually reachable over HTTP. */
export class CapturingEmailSender implements EmailSender {
  private readonly otpByEmail = new Map<string, string>();

  async send(): Promise<void> {
    // Intentionally does nothing — see class doc comment.
  }

  /** Wire this to `createStaffAuth`'s `onOtpGenerated` option. */
  capture(params: { email: string; otp: string }): void {
    this.otpByEmail.set(params.email, params.otp);
  }

  /** Returns and forgets the last captured OTP for `email` — one-shot, like a real inbox message
   * being consumed, so a stale code can't be replayed across tests. */
  takeOtp(email: string): string | undefined {
    const otp = this.otpByEmail.get(email);
    this.otpByEmail.delete(email);
    return otp;
  }
}
