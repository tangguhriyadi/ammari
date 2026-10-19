"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, X } from "lucide-react";
import { cn } from "../lib/cn";

export type ToastVariant = "success" | "error";

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

export interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
}

const DISMISS_AFTER_MS = 4000;
// Errors are not announced-and-gone: give a slow reader time, and keep the stack small.
const ERROR_DISMISS_AFTER_MS = 8000;
const MAX_VISIBLE = 3;

const ToastContext = createContext<ToastApi | null>(null);

/** Lives in a layout that survives navigation (the admin shell), so a toast raised right before
 * `router.push` is still on screen on the destination page. It is in-memory only: a refresh or
 * back navigation shows nothing, which is the "exactly once" guarantee. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((variant: ToastVariant, message: string) => {
    nextId.current += 1;
    const id = nextId.current;
    setToasts((current) => [...current, { id, message, variant }].slice(-MAX_VISIBLE));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({ success: (message) => push("success", message), error: (message) => push("error", message) }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Offset below the fixed mobile topbar (h-14) so the account/menu buttons stay tappable;
          the topbar is hidden from lg, where the toast returns to the top edge.
          The live region is always mounted (even when empty): screen readers only announce
          changes inside a region that already existed. Full width on phones, a 24rem column
          at the top right from `sm`. pointer-events-none on the wrapper so it never blocks the
          page underneath; only the toasts themselves are clickable. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+4rem)] lg:top-[calc(env(safe-area-inset-top)+0.75rem)] z-[100] flex flex-col items-stretch gap-2 px-4 sm:inset-x-auto sm:right-4 sm:w-96 sm:px-0"
      >
        {toasts.map((toast) => (
          <ToastView key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.variant === "error" ? ERROR_DISMISS_AFTER_MS : DISMISS_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div
      data-toast={toast.variant}
      role={toast.variant === "error" ? "alert" : undefined}
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-lg border px-4 py-3 text-base shadow-lg",
        toast.variant === "success"
          ? "border-success-700/20 bg-success-50 text-success-700"
          : "border-danger-700/20 bg-danger-50 text-danger-700",
      )}
    >
      {toast.variant === "success" ? (
        <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      ) : (
        <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      )}
      <p className="flex-1">{toast.message}</p>
      <button
        type="button"
        aria-label="Tutup notifikasi"
        onClick={() => onDismiss(toast.id)}
        className="-m-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-black/5"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside <ToastProvider>");
  return context;
}
