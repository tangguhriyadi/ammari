"use client";

import { useActionState } from "react";
import { Button } from "@ammari/ui";
import { formatDate } from "@ammari/ui/lib";
import { claimAction, type ClaimActionState } from "./actions";

const USABLE_FROM = "1 Desember 2026";

const initialState: ClaimActionState = { status: "idle" };

export function ClaimForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(claimAction, initialState);

  if (state.status === "success") {
    return (
      <div className="flex flex-col items-center gap-3">
        <p className="text-base font-medium text-neutral-900">Voucher Rp20.000 berhasil diklaim!</p>
        <p className="max-w-sm text-sm text-neutral-700">
          Bisa dipakai mulai {USABLE_FROM} di ammari.id, berlaku sampai {formatDate(new Date(state.expiresAt))}.
        </p>
        <a href="/account" className="text-sm font-medium text-brand underline">
          Lihat akun saya
        </a>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col items-center gap-3">
      <input type="hidden" name="token" value={token} />
      {state.status === "error" && (
        <p role="alert" className="text-sm text-danger-700">
          {state.message}
        </p>
      )}
      <Button type="submit" loading={pending}>
        Klaim Sekarang
      </Button>
    </form>
  );
}
