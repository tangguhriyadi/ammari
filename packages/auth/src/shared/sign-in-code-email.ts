import { renderSignInCodeEmail } from "@ammari/email";
import type { EmailMessage } from "../email-sender";

// The sign-in code email both auth instances send (docs/plans/email-design.md §3); the layout and
// wording live in @ammari/email.

/** Shaved off the shown expiry so the minute it shows is never later than the real one: the code
 * row is written a moment before this runs, and the time is shown to the minute only. */
const EXPIRY_DISPLAY_MARGIN_MS = 5_000;

export function signInCodeMessage(params: {
  audience: "customer" | "staff";
  to: string;
  otp: string;
  expiresInSeconds: number;
  logoUrl: string | null;
  now?: Date;
}): EmailMessage {
  const now = params.now ?? new Date();
  const email = renderSignInCodeEmail({
    audience: params.audience,
    code: params.otp,
    expiresAt: new Date(now.getTime() + params.expiresInSeconds * 1000 - EXPIRY_DISPLAY_MARGIN_MS),
    // At least 1: only an e2e expiry override (a few seconds) is ever under a minute.
    validMinutes: Math.max(1, Math.round(params.expiresInSeconds / 60)),
    logoUrl: params.logoUrl,
  });
  return { to: params.to, subject: email.subject, body: email.text, html: email.html };
}
