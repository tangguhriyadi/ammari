import { formatWib } from "./format";
import { button, details, heading, muted, paragraph, renderEmail, type RenderedEmail } from "./layout";

// The "you've been invited" email (docs/plans/roles-staff.md §5, docs/plans/email-design.md §3).
// It carries no token or magic link: the button only opens the admin site, where logging in is
// still Google or an email code for this exact address, so the email holds nothing an attacker
// could use. The plain address is shown under the button so the reader can check where it goes.

export interface StaffInviteEmailInput {
  to: string;
  name: string;
  roleName: string;
  /** The admin app's own origin, e.g. "https://admin.ammari.id". */
  loginUrl: string;
  inviteExpiresAt: Date;
  logoUrl: string | null;
}

export function renderStaffInviteEmail(input: StaffInviteEmailInput): RenderedEmail {
  const expires = formatWib(input.inviteExpiresAt);
  return renderEmail({
    subject: "Undangan ke Admin Ammari",
    preheader: `Masuk dengan ${input.to} sebelum ${expires}.`,
    sections: [
      heading("Undangan ke Admin Ammari"),
      paragraph(`Halo ${input.name},`),
      paragraph(`Anda diundang ke Admin Ammari sebagai ${input.roleName}.`),
      button("Buka Admin Ammari", input.loginUrl),
      details("Cara masuk", [
        { label: "Alamat", value: input.loginUrl },
        { label: "Email", value: input.to },
        { label: "Metode", value: "Google, atau kode lewat email" },
        { label: "Berlaku sampai", value: expires },
      ]),
      paragraph(`Masuklah memakai alamat email ini (${input.to}). Alamat email lain tidak bisa masuk dengan undangan ini.`),
      muted("Kalau Anda tidak merasa diundang, abaikan email ini."),
    ],
    footerNote: "Email ini dikirim karena pemilik Ammari mengundang alamat email ini ke Admin Ammari.",
    logoUrl: input.logoUrl,
  });
}
