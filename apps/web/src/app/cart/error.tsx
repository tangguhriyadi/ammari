"use client";

import { PrimaryButton } from "@/components/buttons";
import { Container } from "@/components/container";
import { StalePageNotice } from "@/components/stale-page-notice";
import { isStaleDeploymentError } from "@/lib/stale-deployment";

// A failed cart read (database briefly down) gets an Indonesian message and a retry instead of
// the framework's default error screen. The error itself is already logged on the server.
export default function CartError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  // A page from the previous build reloads itself (lib/stale-deployment.ts).
  if (isStaleDeploymentError(error)) return <StalePageNotice />;
  return (
    <Container className="flex flex-col items-start gap-6 py-10">
      <h1 className="font-serif text-[30px] font-normal text-ink">Keranjang</h1>
      <p className="text-sm text-ink-muted">Keranjang tidak bisa dimuat sekarang. Coba lagi sebentar lagi.</p>
      <PrimaryButton onClick={() => retry()} className="w-full md:w-auto">
        Coba lagi
      </PrimaryButton>
    </Container>
  );
}
