"use client";

import { useState } from "react";
import { Button } from "@ammari/ui";
import { formatDate } from "@ammari/ui/lib";

export interface InviteNoticeData {
  name: string;
  email: string;
  inviteExpiresAt: string;
  emailSent: boolean;
}

/** What to tell the new person (owner answer 8): the invite email is a convenience, so the owner
 * is always reminded to message them on WhatsApp too, with the admin address and the exact email
 * to log in with. Shown after an invite and after "Kirim ulang undangan". */
export function whatsappReminderText({ name, email }: { name: string; email: string }, adminUrl: string): string {
  return `Halo ${name}, Anda sudah diundang ke Admin Ammari. Buka ${adminUrl} lalu masuk dengan Google atau kode lewat email, memakai alamat ${email}.`;
}

export function InviteNotice({
  notice,
  adminUrl,
  onResend,
  resending,
}: {
  notice: InviteNoticeData;
  adminUrl: string;
  /** Offered only when the email failed. */
  onResend?: () => void;
  resending?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const message = whatsappReminderText(notice, adminUrl);
  const until = formatDate(new Date(notice.inviteExpiresAt));

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
    } catch {
      // Clipboard can be refused (permissions, insecure context); the text stays on screen to
      // copy by hand, so there is nothing else to do.
      setCopied(false);
    }
  }

  return (
    <div role="status" data-testid="invite-notice" className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
      {notice.emailSent ? (
        <p className="text-base text-neutral-900">Undangan dibuat. Berlaku sampai {until}.</p>
      ) : (
        <p className="text-base text-danger-700">
          Undangan dibuat (berlaku sampai {until}), tapi email gagal terkirim. Minta staf membuka {adminUrl} dan masuk dengan email ini.
        </p>
      )}
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-neutral-900">Kirim juga pesan WhatsApp ke {notice.name}:</p>
        <p className="break-words rounded-md bg-white p-3 text-sm text-neutral-700" data-testid="whatsapp-reminder">
          {message}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={copy}>
          {copied ? "Tersalin" : "Salin pesan"}
        </Button>
        {!notice.emailSent && onResend && (
          <Button variant="secondary" onClick={onResend} loading={resending}>
            Kirim ulang undangan
          </Button>
        )}
      </div>
    </div>
  );
}
