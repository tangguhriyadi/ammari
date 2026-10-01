"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}

/** A bottom-anchored sheet built on native `<dialog>` — same focus-trap/Escape/backdrop
 * mechanics as @ammari/ui's Dialog, with bottom-sheet positioning instead of a centered card.
 * Used for "Lainnya" (overflow nav) and the mobile account menu — admin-shell-specific chrome,
 * not a shared design-system primitive. */
export function Sheet({ open, onOpenChange, title, children }: SheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className={
        "m-0 mt-auto max-h-[80vh] w-full max-w-none rounded-t-lg border-t border-neutral-200 bg-white p-0 shadow-md " +
        "pb-[env(safe-area-inset-bottom)] [&::backdrop]:bg-black/40"
      }
      onClose={() => onOpenChange(false)}
      onCancel={() => onOpenChange(false)}
      onClick={(event) => {
        if (event.target === dialogRef.current) onOpenChange(false);
      }}
    >
      {/* Stops a backdrop click's propagation so the handler above doesn't treat content clicks
          as backdrop clicks; it adds no independent interaction of its own. */}
      <div onClick={(event) => event.stopPropagation()} className="flex flex-col gap-4 p-4">
        <div className="flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-semibold text-neutral-900">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Tutup"
            onClick={() => onOpenChange(false)}
            className="flex size-11 items-center justify-center rounded-md text-neutral-600 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
