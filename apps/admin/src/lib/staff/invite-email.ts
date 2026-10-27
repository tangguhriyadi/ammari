import type { EmailMessage } from "@ammari/auth";
import { renderStaffInviteEmail } from "@ammari/email";

export interface StaffInviteEmailInput {
  to: string;
  name: string;
  roleName: string;
  /** The admin app's own origin (BETTER_AUTH_URL), e.g. "https://admin.ammari.id". */
  loginUrl: string;
  inviteExpiresAt: Date;
  /** The logo in the header: an absolute https URL on the storefront, or null for text only. */
  logoUrl: string | null;
  /** Unique per invitation window, so a provider retry delivers it once. */
  idempotencyKey: string;
}

/** The "you've been invited" email (docs/plans/roles-staff.md §5). It carries no token or magic
 * link: logging in is still Google or an email code for this exact address, so the email holds
 * nothing an attacker could use. Wording and layout: @ammari/email (docs/plans/email-design.md). */
export function buildStaffInviteEmail(input: StaffInviteEmailInput): EmailMessage {
  const email = renderStaffInviteEmail({
    to: input.to,
    name: input.name,
    roleName: input.roleName,
    loginUrl: input.loginUrl,
    inviteExpiresAt: input.inviteExpiresAt,
    logoUrl: input.logoUrl,
  });
  return {
    to: input.to,
    subject: email.subject,
    body: email.text,
    html: email.html,
    idempotencyKey: input.idempotencyKey,
  };
}
