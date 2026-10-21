"use client";

import { PrimaryButton } from "@/components/buttons";
import { Container } from "@/components/container";

// A failed "Pesanan saya" read (database briefly down) gets an Indonesian message and a retry
// instead of the framework's default error screen, like /cart and /checkout. The error itself is
// already logged on the server. Covers /orders and /orders/[orderNo].
export default function OrdersError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <Container className="flex max-w-[640px] flex-col items-start gap-6 py-10">
      <h1 className="font-serif text-[30px] font-normal text-ink">Pesanan saya</h1>
      <p className="text-sm text-ink-muted">Pesanan belum bisa ditampilkan sekarang. Coba lagi sebentar lagi.</p>
      <PrimaryButton onClick={() => retry()} className="w-full md:w-auto">
        Coba lagi
      </PrimaryButton>
    </Container>
  );
}
