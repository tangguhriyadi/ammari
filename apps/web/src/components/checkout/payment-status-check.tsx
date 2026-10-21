"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { checkPaymentStatusAction } from "@/lib/checkout/payment-actions";
import { isStaleDeploymentError, scheduleStaleReload } from "@/lib/stale-deployment";

// The finish page's one status check (docs/plans/cart-checkout.md §4.4) for an order that still
// shows as pending: once per page load, the server asks the gateway (never trusting the redirect's
// query string) and the page re-reads our database when the payment state moved. A failed check
// leaves the page as it is (the notification or the sweep finalizes it). The ref makes StrictMode's
// second effect run a no-op; the answer is acted on even after a remount (a refresh is harmless).

export function PaymentStatusCheck({ orderNo }: { orderNo: string }) {
  const router = useRouter();
  const started = useRef<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (started.current === orderNo) return;
    started.current = orderNo;
    checkPaymentStatusAction(orderNo)
      .then((result) => {
        if (result.changed) router.refresh();
      })
      .catch((error: unknown) => {
        console.warn("[checkout] payment status check did not answer", error instanceof Error ? error.name : typeof error);
        // A page from the previous build: reload it, so the check runs against the new one.
        if (isStaleDeploymentError(error)) scheduleStaleReload();
      })
      .finally(() => setChecking(false));
  }, [orderNo, router]);

  return (
    <p role="status" aria-live="polite" className="text-xs text-ink-muted">
      {checking ? "Memeriksa status pembayaran..." : ""}
    </p>
  );
}
