"use client";

import { PrimaryButton } from "@/components/buttons";
import { Container } from "@/components/container";

// A failed checkout read (database briefly down) gets an Indonesian message and a retry instead of
// the framework's default error screen, like /cart. The error itself is already logged on the
// server. Also covers /checkout/finish.
export default function CheckoutError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <Container className="flex flex-col items-start gap-6 py-10">
      <h1 className="font-serif text-[30px] font-normal text-ink">Checkout</h1>
      <p className="text-sm text-ink-muted">Halaman ini tidak bisa dimuat sekarang. Coba lagi sebentar lagi.</p>
      <PrimaryButton onClick={() => retry()} className="w-full md:w-auto">
        Coba lagi
      </PrimaryButton>
    </Container>
  );
}
