"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { changePaymentMethodAction } from "@/lib/checkout/payment-actions";
import { goToPaymentPage } from "@/lib/checkout/navigate";

// "Ganti metode pembayaran" (owner request after the 2026-10-21 sandbox run): the payment page
// stays locked to the method the buyer picked there (e.g. GoPay QR). The server ends that attempt
// at the gateway first, then opens a new payment page for the same order and the rest of its window
// where every method can be chosen again (@ammari/commerce/payments changePaymentMethod). Shown
// next to "Lanjutkan pembayaran" on the finish page and the order page while the order is payable.

const LOST_MESSAGE = "Koneksi terputus. Coba lagi.";
const NOT_OPENED_MESSAGE = "Halaman pembayaran belum bisa dibuka. Coba lagi sebentar lagi atau hubungi kami lewat WhatsApp.";

export function ChangePaymentMethodButton({ orderNo }: { orderNo: string }) {
  const router = useRouter();
  const noteId = useId();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Stays true once the browser is leaving for the payment page, so a second tap during the unload
  // never opens another attempt.
  const [navigating, setNavigating] = useState(false);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const busy = pending || navigating;

  function fail(text: string) {
    setMessage(text);
    requestAnimationFrame(() => alertRef.current?.focus());
  }

  function change() {
    if (busy) return;
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await changePaymentMethodAction(orderNo);
        if (!result.ok) {
          fail(result.message);
          // The order's payment state moved (paid meanwhile, or closed): show it.
          if (result.refresh) startTransition(() => router.refresh());
          return;
        }
        if (goToPaymentPage(result.redirectUrl)) setNavigating(true);
        else {
          console.warn("[checkout] new payment page refused by the browser-side URL check");
          fail(NOT_OPENED_MESSAGE);
        }
      } catch (error) {
        console.warn("[checkout] payment method change did not answer", error instanceof Error ? error.name : typeof error);
        fail(LOST_MESSAGE);
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={change}
        aria-disabled={busy || undefined}
        aria-describedby={noteId}
        className="inline-flex min-h-[52px] w-full items-center justify-center border border-ink px-6 text-xs font-medium tracking-[0.2em] text-ink uppercase aria-disabled:cursor-progress aria-disabled:opacity-60"
      >
        {busy ? "Membuka..." : "Ganti metode pembayaran"}
      </button>
      <p id={noteId} className="text-xs text-ink-muted">
        Pembayaran yang belum selesai dengan metode sebelumnya dibatalkan, lalu kamu bisa memilih metode lain.
      </p>
      {message && (
        <p ref={alertRef} role="alert" tabIndex={-1} className="border border-error-border px-4 py-3 text-sm text-error">
          {message}
        </p>
      )}
    </div>
  );
}
