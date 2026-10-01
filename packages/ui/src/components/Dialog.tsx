"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";
import { Button, type ButtonVariant } from "./Button";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  confirmVariant?: ButtonVariant;
  loading?: boolean;
}

/** Built on native `<dialog>` rather than a bespoke implementation: focus trapping, Escape-to-
 * close, and the backdrop all come from the browser for free. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Konfirmasi",
  cancelLabel = "Batal",
  onConfirm,
  confirmVariant = "primary",
  loading = false,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

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
      aria-describedby={description ? descriptionId : undefined}
      className={
        "m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-neutral-200 bg-white p-6 shadow-md " +
        "[&::backdrop]:bg-black/40"
      }
      onClose={() => onOpenChange(false)}
      onCancel={() => onOpenChange(false)}
      onClick={(event) => {
        // A click that lands on the <dialog> element itself (not its content) is a backdrop
        // click — the content wrapper below stops propagation before it reaches here.
        if (event.target === dialogRef.current) onOpenChange(false);
      }}
    >
      {/* Stops a backdrop click's propagation so the handler above doesn't treat content clicks
          as backdrop clicks; it adds no independent interaction of its own. */}
      <div onClick={(event) => event.stopPropagation()}>
        <h2 id={titleId} className="text-lg font-semibold text-neutral-900">
          {title}
        </h2>
        {description && (
          <p id={descriptionId} className="mt-1 text-base text-neutral-600">
            {description}
          </p>
        )}
        {children && <div className="mt-4">{children}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          {onConfirm && (
            <Button variant={confirmVariant} onClick={onConfirm} loading={loading}>
              {confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </dialog>
  );
}
