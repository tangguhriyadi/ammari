import type { Metadata } from "next";
import Link from "next/link";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { LOGIN_LINK_CONSUME_ACTION, LOGIN_LINK_SUCCESS_PATH, loadLoginLinkPageState } from "@/lib/auth/login-link";
import { LoginLinkForm } from "./login-link-form";

// "Masuk ke akun" confirm page (docs/plans/cart-checkout.md §9.3, session 14). Opening it never logs
// in: it only looks the link up and shows a "Masuk" button whose form POST does the login. The URL
// carries the token, so the page is noindex and sends `Referrer-Policy: same-origin` (owner decision
// 2026-10-21: the token never leaves the site, and the form POST still carries the real Origin the
// CSRF check compares); next.config.ts sends the same as headers, with no-store.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Masuk ke akun",
  robots: { index: false, follow: false },
  referrer: "same-origin",
};

const OTP_LOGIN_HREF = `/login?next=${encodeURIComponent(LOGIN_LINK_SUCCESS_PATH)}`;

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center bg-neutral-50 px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="font-serif text-2xl font-light text-brand">{title}</h1>
        {children}
      </div>
    </div>
  );
}

// The shared Button's primary look, for links.
const linkButton =
  "inline-flex min-h-11 items-center justify-center rounded-md bg-brand px-4 text-base font-medium text-brand-foreground hover:bg-neutral-800 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2";

export default async function LoginLinkPage({ searchParams }: { searchParams: Promise<{ token?: string | string[]; status?: string | string[] }> }) {
  const params = await searchParams;
  const [state, customer] = await Promise.all([loadLoginLinkPageState(params), getCustomerSession()]);

  if (state.kind === "confirm" && customer?.id === state.link.customerId) {
    return (
      <Shell title="Kamu sudah masuk">
        <p className="text-sm text-neutral-700">Kamu sudah masuk ke akun ini. Link di email tetap bisa dipakai sampai kedaluwarsa.</p>
        <Link href={LOGIN_LINK_SUCCESS_PATH} className={linkButton}>
          Buka akun saya
        </Link>
      </Shell>
    );
  }

  if (state.kind === "confirm") {
    return (
      <Shell title="Masuk ke akun">
        <p className="break-all text-base text-neutral-900">
          Masuk sebagai <span className="font-medium">{state.link.maskedEmail}</span>
        </p>
        <LoginLinkForm action={LOGIN_LINK_CONSUME_ACTION} token={state.token} />
        <p className="text-sm text-neutral-600">Link ini hanya bisa dipakai sekali dan berlaku 24 jam sejak email dikirim.</p>
      </Shell>
    );
  }

  const copy = {
    invalid: { title: "Link sudah tidak berlaku", text: "Link masuk hanya bisa dipakai sekali, berlaku 24 jam, dan diganti oleh link di email yang lebih baru. Kamu tetap bisa masuk dengan kode yang kami kirim ke email." },
    limited: { title: "Terlalu banyak percobaan", text: "Coba lagi beberapa menit lagi, atau masuk dengan kode yang kami kirim ke email." },
    blocked: { title: "Permintaan tidak bisa diproses", text: "Buka lagi link dari email kamu dan tekan Masuk, atau masuk dengan kode yang kami kirim ke email." },
    error: { title: "Terjadi kesalahan", text: "Kamu belum masuk. Coba buka lagi link dari email kamu, atau masuk dengan kode yang kami kirim ke email." },
  }[state.kind];

  return (
    <Shell title={copy.title}>
      <p className="text-sm text-neutral-700">{copy.text}</p>
      {customer ? (
        <Link href={LOGIN_LINK_SUCCESS_PATH} className={linkButton}>
          Buka akun saya
        </Link>
      ) : (
        <Link href={OTP_LOGIN_HREF} className={linkButton}>
          Masuk dengan kode
        </Link>
      )}
    </Shell>
  );
}
