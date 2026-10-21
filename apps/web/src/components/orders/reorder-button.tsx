"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { CART_CALL_FAILED_MESSAGE, announceCartCount } from "@/lib/cart/count-event";
import { reorderAction, type ReorderActionResult } from "@/lib/orders/reorder-actions";
import { REORDER_ALL_ADDED, REORDER_NONE_ADDED, REORDER_SOME_ADDED } from "@/lib/orders/reorder-messages";
import { PrimaryButton } from "@/components/buttons";
import { CART_MAX_PIECES } from "@ammari/commerce/cart-limits";

// "Pesan lagi" (docs/plans/cart-checkout.md §4.4, §9.1): on a cancelled, never-paid checkout order,
// puts its lines back into the cart (what fits; the server decides) and announces the new cart
// count to the header. Each line that went in short or not at all is named with its reason, never
// a stock count; "Lihat keranjang" once anything went in. Once something went in, the button is
// gone (a second tap would add the same lines again); a reload brings it back on purpose.

type Done = Extract<ReorderActionResult, { ok: true }>;

export function ReorderButton({ orderNo, className }: { orderNo: string; className?: string }) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  function focusResult() {
    requestAnimationFrame(() => resultRef.current?.focus());
  }

  function fail(message: string) {
    setDone(null);
    setError(message);
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  function reorder() {
    if (pending) return;
    setError(null);
    setDone(null);
    startTransition(async () => {
      try {
        const result = await reorderAction(orderNo);
        if (!result.ok) {
          fail(result.message);
        } else {
          setDone(result);
          announceCartCount(result.pieceCount);
          focusResult();
        }
      } catch (callError) {
        console.warn("[orders] reorder did not answer", callError instanceof Error ? callError.name : typeof callError);
        fail(CART_CALL_FAILED_MESSAGE);
      }
    });
  }

  const filled = done !== null && done.addedPieces > 0;
  const summary = done ? (done.addedPieces === 0 ? REORDER_NONE_ADDED : done.notes.length === 0 ? REORDER_ALL_ADDED : REORDER_SOME_ADDED) : null;

  return (
    <div className={className}>
      {!filled && (
        <PrimaryButton onClick={reorder} aria-disabled={pending || undefined} className="w-full aria-disabled:cursor-progress aria-disabled:opacity-60">
          {pending ? "Memproses..." : "Pesan lagi"}
        </PrimaryButton>
      )}
      <div ref={resultRef} tabIndex={-1} role="status" aria-live="polite" className={filled ? "outline-none" : "mt-3 outline-none empty:mt-0"}>
        {done && summary && (
          <div className="flex flex-col gap-2 bg-surface px-4 py-3 text-sm text-ink" data-testid="reorder-result">
            <p>{summary}</p>
            {done.notes.length > 0 && (
              <ul className="flex flex-col gap-1 text-ink-muted">
                {done.notes.map((note, index) => (
                  <li key={`${note.name}-${note.variant}-${index}`}>
                    {note.name} ({note.variant}): {note.message}
                  </li>
                ))}
              </ul>
            )}
            {done.mergeTrimmed && <p className="text-ink-muted">Maksimal {CART_MAX_PIECES} barang per pesanan.</p>}
            {done.addedPieces > 0 && (
              <Link href="/cart" className="inline-flex min-h-[44px] items-center self-start text-xs font-medium tracking-[0.16em] text-ink uppercase underline underline-offset-4">
                Lihat keranjang
              </Link>
            )}
          </div>
        )}
      </div>
      {error && (
        <p ref={errorRef} role="alert" tabIndex={-1} className="mt-3 border border-error-border px-4 py-3 text-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}
