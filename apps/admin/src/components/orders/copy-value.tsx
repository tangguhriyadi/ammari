"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

// A value staff copy into another tool (the Biteship order id for the activation form and support,
// Phase K4): shown as selectable text with a "Salin" button. A refused clipboard says to copy by
// hand; the value stays selectable.

type CopyState = "idle" | "copied" | "failed";

export function CopyValue({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch (error) {
      console.warn("[orders] copy to clipboard failed", error instanceof Error ? error.name : typeof error);
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), 2_000);
  }

  return (
    <span className="flex min-w-0 items-center gap-2 sm:justify-end">
      <span className="font-mono text-sm break-all text-neutral-900" data-testid={testId}>
        {value}
      </span>
      <button
        type="button"
        onClick={copy}
        className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-neutral-700 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
      >
        {state === "copied" ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
        {state === "copied" ? "Tersalin" : "Salin"}
        <span className="sr-only"> {label}</span>
      </button>
      <span role="status" aria-live="polite" className={state === "failed" ? "text-sm text-danger-700" : "sr-only"}>
        {state === "copied" ? "Tersalin." : state === "failed" ? "Gagal menyalin. Salin manual." : ""}
      </span>
    </span>
  );
}
