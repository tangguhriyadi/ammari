"use client";

import { useEffect, useRef, useState } from "react";

// "Salin" next to the resi in "Lacak pengiriman" (docs/plans/cart-checkout.md §15 Phase K, K4): puts
// the text on the clipboard and says so for a moment. Where the browser refuses the clipboard (an
// older WebView, a denied permission), it says to copy by hand; the resi stays selectable text.

type CopyState = "idle" | "copied" | "failed";

const RESET_MS = 2_000;

export function CopyTextButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch (error) {
      console.warn("[orders] copy to clipboard failed", error instanceof Error ? error.name : typeof error);
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), RESET_MS);
  }

  return (
    <>
      <button
        type="button"
        onClick={copy}
        data-testid={testId}
        className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-xs text-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        {state === "copied" ? "Tersalin" : "Salin"}
        <span className="sr-only"> {label}</span>
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" ? "Nomor resi tersalin." : state === "failed" ? "Gagal menyalin. Salin manual." : ""}
      </span>
      {state === "failed" && (
        <span aria-hidden="true" className="basis-full text-right text-xs text-error">
          Gagal menyalin. Salin manual.
        </span>
      )}
    </>
  );
}
