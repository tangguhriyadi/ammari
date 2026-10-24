"use client";

import { LogOut } from "lucide-react";
import type { StaffSessionData } from "@ammari/auth/staff";
import { clearRememberedOtpSendAttempt } from "@ammari/ui/lib";
import { logoutAction } from "@/app/actions";

// Must match login-form.tsx's own OTP_LAST_SEND_STORAGE_KEY_PREFIX exactly — see that file's
// own doc comment for why this guard exists, and why it must be cleared on sign-out (the next
// sign-in, possibly by a different person on a shared device, must not inherit this one's
// same-browser memory of a send attempt for this email).
const OTP_LAST_SEND_STORAGE_KEY_PREFIX = "ammari-admin-otp-last-send";

function initialsOf(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
  return letters || "?";
}

export function AccountMenu({ session, compact = false }: { session: StaffSessionData; compact?: boolean }) {
  if (compact) {
    return (
      <div className="flex flex-col items-center gap-3">
        <span
          title={`${session.staffUser.name} (${session.role.name})`}
          className="flex size-10 items-center justify-center rounded-full bg-neutral-100 text-sm font-semibold text-brand"
        >
          <span aria-hidden="true">{initialsOf(session.staffUser.name)}</span>
          <span className="sr-only">{`${session.staffUser.name}, ${session.role.name}`}</span>
        </span>
        <form
          action={logoutAction}
          onSubmit={() => {
            void clearRememberedOtpSendAttempt(OTP_LAST_SEND_STORAGE_KEY_PREFIX, session.staffUser.email);
          }}
        >
          <button
            type="submit"
            aria-label="Keluar"
            title="Keluar"
            className="flex size-11 items-center justify-center rounded-md border border-neutral-500 text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
          >
            <LogOut aria-hidden="true" className="size-4" />
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col">
        <span className="text-base font-medium text-neutral-900">{session.staffUser.name}</span>
        <span className="text-sm text-neutral-600">{session.role.name}</span>
      </div>
      <form
        action={logoutAction}
        onSubmit={() => {
          void clearRememberedOtpSendAttempt(OTP_LAST_SEND_STORAGE_KEY_PREFIX, session.staffUser.email);
        }}
      >
        <button
          type="submit"
          className="flex min-h-11 w-full items-center gap-2 rounded-md border border-neutral-500 px-3 text-base font-medium text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        >
          <LogOut aria-hidden="true" className="size-4" />
          Keluar
        </button>
      </form>
    </div>
  );
}
