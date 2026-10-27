import { formatWibTime } from "./format";
import { code, heading, muted, paragraph, renderEmail, type RenderedEmail } from "./layout";

// The sign-in code emails (customer: the storefront's "Masuk"; staff: Admin Ammari's login),
// docs/plans/email-design.md §3. Deliberately no link or button anywhere: a sign-in code email
// that never links is one a phishing copy with a "Masuk di sini" button cannot pass for. The code
// is never in the subject or the preheader, so it does not show on a lock screen notification.

export interface SignInCodeEmailInput {
  audience: "customer" | "staff";
  code: string;
  /** When the code stops working, for "sampai pukul 14.35 WIB". */
  expiresAt: Date;
  /** The code's lifetime in whole minutes, for "Berlaku 5 menit". */
  validMinutes: number;
  logoUrl: string | null;
}

const COPY = {
  customer: { subject: "Kode masuk Ammari", place: "akun Ammari kamu" },
  staff: { subject: "Kode masuk Ammari Admin", place: "Admin Ammari" },
} as const;

export function renderSignInCodeEmail(input: SignInCodeEmailInput): RenderedEmail {
  const copy = COPY[input.audience];
  const validity = `Berlaku ${input.validMinutes} menit, sampai pukul ${formatWibTime(input.expiresAt)}.`;
  return renderEmail({
    subject: copy.subject,
    preheader: `Kode ini ${validity.charAt(0).toLowerCase()}${validity.slice(1)} Jangan bagikan ke siapa pun.`,
    sections: [
      heading("Kode masuk kamu"),
      paragraph(`Masukkan kode ini di halaman masuk ${copy.place}.`),
      code(input.code),
      paragraph(validity),
      muted("Jangan bagikan kode ini ke siapa pun, termasuk yang mengaku dari tim Ammari. Kami tidak pernah meminta kode ini."),
      muted("Kalau bukan kamu yang meminta kode ini, abaikan saja email ini."),
    ],
    footerNote: `Email ini dikirim karena ada permintaan masuk ke ${copy.place} dengan alamat email ini.`,
    logoUrl: input.logoUrl,
  });
}
