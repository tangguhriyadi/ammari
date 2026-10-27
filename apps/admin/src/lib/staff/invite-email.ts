import type { EmailMessage } from "@ammari/auth";
import { formatDateTime } from "@ammari/ui/lib";

export interface StaffInviteEmailInput {
  to: string;
  name: string;
  roleName: string;
  /** The admin app's own origin (BETTER_AUTH_URL), e.g. "https://admin.ammari.id". */
  loginUrl: string;
  inviteExpiresAt: Date;
  /** Unique per invitation window, so a provider retry delivers it once. */
  idempotencyKey: string;
}

/** The "you've been invited" email (docs/plans/roles-staff.md §5). It carries no token or magic
 * link: logging in is still Google or an email code for this exact address, so the email holds
 * nothing an attacker could use. Indonesian, plain text. */
export function buildStaffInviteEmail(input: StaffInviteEmailInput): EmailMessage {
  const body = [
    `Halo ${input.name},`,
    "",
    `Anda diundang ke Admin Ammari sebagai ${input.roleName}.`,
    "",
    `Buka ${input.loginUrl} lalu masuk dengan Google atau kode lewat email, memakai alamat email ini (${input.to}).`,
    "",
    `Undangan ini berlaku sampai ${formatDateTime(input.inviteExpiresAt)} WIB.`,
    "",
    "Kalau Anda tidak merasa diundang, abaikan email ini.",
  ].join("\n");
  return {
    to: input.to,
    subject: "Undangan ke Admin Ammari",
    body,
    idempotencyKey: input.idempotencyKey,
  };
}
