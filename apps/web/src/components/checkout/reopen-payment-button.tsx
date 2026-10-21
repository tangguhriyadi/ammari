"use client";

import { useRef, useState, useTransition } from "react";
import { reopenPaymentPageAction } from "@/lib/checkout/payment-actions";
import { goToPaymentPage } from "@/lib/checkout/navigate";

// "Buka halaman pembayaran" (docs/plans/cart-checkout.md §4.4, session 10 note): shown when a
// pending order has no payment page (the gateway was down when the order was placed). The server
// opens a new payment attempt for the rest of the order's window and the browser goes there.

const LOST_MESSAGE = "Koneksi terputus. Coba lagi.";
const NOT_OPENED_MESSAGE = "Halaman pembayaran belum bisa dibuka. Coba lagi sebentar lagi atau hubungi kami lewat WhatsApp.";

export function ReopenPaymentButton({ orderNo }: { orderNo: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Stays true once the browser is leaving for the payment page, so a second tap during the unload
  // never asks for another page.
  const [navigating, setNavigating] = useState(false);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const busy = pending || navigating;

  function fail(text: string) {
    setMessage(text);
    requestAnimationFrame(() => alertRef.current?.focus());
  }

  function open() {
    if (busy) return;
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await reopenPaymentPageAction(orderNo);
        if (!result.ok) {
          fail(result.message);
          return;
        }
        if (goToPaymentPage(result.redirectUrl)) setNavigating(true);
        else fail(NOT_OPENED_MESSAGE);
      } catch (error) {
        console.warn("[checkout] payment page retry did not answer", error instanceof Error ? error.name : typeof error);
        fail(LOST_MESSAGE);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">Halaman pembayaran belum terbuka. Buka lagi lewat tombol di bawah ini.</p>
      <button
        type="button"
        onClick={open}
        aria-disabled={busy || undefined}
        className="inline-flex min-h-[54px] w-full items-center justify-center bg-pay px-6 text-xs font-medium tracking-[0.2em] text-ink uppercase aria-disabled:cursor-progress aria-disabled:opacity-60"
      >
        {busy ? "Membuka..." : "Buka halaman pembayaran"}
      </button>
      {message && (
        <p ref={alertRef} role="alert" tabIndex={-1} className="border border-error-border px-4 py-3 text-sm text-error">
          {message}
        </p>
      )}
    </div>
  );
}
