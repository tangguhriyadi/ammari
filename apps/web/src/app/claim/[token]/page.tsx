import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { needsConsent } from "@/lib/auth/consent";
import { normalizeClaimTokenInput, hashClaimToken } from "@/lib/claim/token";
import { lookupClaimCard } from "@/lib/claim/queries";
import { getClaimClientIp } from "@/lib/claim/ip";
import { recordClaimAttemptAndCount, CLAIM_VIEW_WINDOW_SECONDS, CLAIM_VIEW_LIMIT } from "@/lib/claim/throttle";
import { defaultDb } from "@/lib/db";
import { CLAIM_ALREADY_MINE_MESSAGE, CLAIM_RATE_LIMITED_MESSAGE, CLAIM_REJECTION_MESSAGES } from "@/lib/claim/messages";
import { ClaimForm } from "./claim-form";

export default async function ClaimTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const next = `/claim/${encodeURIComponent(token)}`;

  const ip = await getClaimClientIp();
  const viewAttempts = await recordClaimAttemptAndCount(defaultDb, ip, "view", CLAIM_VIEW_WINDOW_SECONDS);
  if (viewAttempts >= CLAIM_VIEW_LIMIT) {
    return <ClaimLayout title="Coba lagi sebentar" message={CLAIM_RATE_LIMITED_MESSAGE} />;
  }

  const customer = await getCustomerSession();

  // Pre-login: never validate or reveal anything about the token's actual state — only the
  // generic invite + sign-in options (requirement: no order/buyer details before sign-in, and
  // a rejection outcome is itself information this page must not leak to a signed-out visitor).
  if (!customer) {
    return (
      <ClaimLayout title="Voucher Rp20.000 menunggumu" message="Masuk untuk mengklaim voucher belanja dari Ammari.">
        <Link
          href={`/login?next=${encodeURIComponent(next)}`}
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-brand px-6 text-base font-medium text-brand-foreground transition-colors hover:bg-neutral-800"
        >
          Masuk untuk klaim
        </Link>
      </ClaimLayout>
    );
  }

  if (needsConsent(customer)) {
    redirect(`/consent?next=${encodeURIComponent(next)}`);
  }

  const normalizedToken = normalizeClaimTokenInput(token);
  const tokenHash = hashClaimToken(normalizedToken);
  const preview = await lookupClaimCard(tokenHash, defaultDb);

  if (preview.status === "rejected") {
    if (preview.reason === "claimed" && preview.claimedByCustomerId === customer.id) {
      return <ClaimLayout title="Sudah diklaim" message={CLAIM_ALREADY_MINE_MESSAGE} accountLink />;
    }
    return <ClaimLayout title="Voucher tidak bisa diklaim" message={CLAIM_REJECTION_MESSAGES[preview.reason]} />;
  }

  return (
    <ClaimLayout title="Voucher Rp20.000 menunggumu" message="Klaim sekarang untuk menyimpannya ke akunmu.">
      <ClaimForm token={normalizedToken} />
    </ClaimLayout>
  );
}

function ClaimLayout({
  title,
  message,
  accountLink,
  children,
}: {
  title: string;
  message: string;
  accountLink?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-50 px-4 py-10 text-center">
      <h1 className="font-serif text-2xl font-light text-brand">{title}</h1>
      <p className="max-w-sm text-sm text-neutral-700">{message}</p>
      {accountLink && (
        <a href="/account" className="text-sm font-medium text-brand underline">
          Lihat akun saya
        </a>
      )}
      {children}
    </div>
  );
}
