"use client";

import { PrimaryButton } from "@/components/buttons";
import { Container } from "@/components/container";
import { StalePageNotice } from "@/components/stale-page-notice";
import { isStaleDeploymentError } from "@/lib/stale-deployment";

// Every storefront page without its own error.tsx (account, consent, claim, login, product pages):
// an Indonesian message and a retry instead of the framework's default screen. A page from the
// previous build (a server action or chunk the new deploy does not have) reloads itself instead
// (lib/stale-deployment.ts; 2026-10-21: "Simpan" on /account showed a blank page after a deploy).
export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  if (isStaleDeploymentError(error)) return <StalePageNotice />;
  return (
    <Container className="flex flex-col items-start gap-6 py-10">
      <h1 className="font-serif text-[30px] font-normal text-ink">Terjadi kesalahan</h1>
      <p className="text-sm text-ink-muted">Halaman ini tidak bisa dimuat sekarang. Coba lagi sebentar lagi.</p>
      <PrimaryButton onClick={() => retry()} className="w-full md:w-auto">
        Coba lagi
      </PrimaryButton>
    </Container>
  );
}
