"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button, Input, Label } from "@ammari/ui";
import { ACCOUNT_NAME_MAX_LENGTH } from "@/lib/account/name";
import { updateAccountNameAction, type AccountNameState } from "./name-actions";

const initialState: AccountNameState = {};

/** The account name on /account, with "Ubah nama" (2026-10-21 sandbox run). `isPlaceholder`: the
 * account still has the name an email login gives ("Pelanggan Ammari"), so the button invites the
 * buyer to set their own. */
export function AccountName({ name, isPlaceholder }: { name: string; isPlaceholder: boolean }) {
  const [state, formAction, pending] = useActionState(updateAccountNameAction, initialState);
  const [editing, setEditing] = useState(false);
  // The submit that `state` answers: a fresh save closes the form, an older one never reopens it.
  const [answered, setAnswered] = useState<AccountNameState>(initialState);
  // An error belongs to the submit it answered: reopening the form after "Batal" starts clean.
  const [showError, setShowError] = useState(false);
  // The last saved name survives a later failed submit (whose state has no `saved`).
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const shown = lastSaved ?? name;

  if (state !== answered) {
    setAnswered(state);
    setShowError(Boolean(state.error));
    if (state.saved) {
      setLastSaved(state.saved);
      setEditing(false);
    }
  }
  const saved = lastSaved !== null;

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Saved: the form closes, so focus goes back to the button that opened it.
  useEffect(() => {
    if (state.saved) toggleRef.current?.focus();
  }, [state]);

  if (!editing) {
    return (
      <div className="flex items-center justify-between gap-3">
        <p className={isPlaceholder && !saved ? "text-base text-neutral-600" : "text-base font-medium text-neutral-900"} data-testid="account-name">
          {shown}
        </p>
        <button
          ref={toggleRef}
          type="button"
          onClick={() => {
            setShowError(false);
            setEditing(true);
          }}
          className="inline-flex min-h-[44px] items-center text-sm font-medium text-brand underline underline-offset-4"
        >
          {isPlaceholder && !saved ? "Isi nama" : "Ubah nama"}
        </button>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="account-name">Nama</Label>
        <Input
          ref={inputRef}
          id="account-name"
          name="name"
          type="text"
          autoComplete="name"
          defaultValue={showError && state.value !== undefined ? state.value : isPlaceholder && !saved ? "" : shown}
          maxLength={ACCOUNT_NAME_MAX_LENGTH}
          required
          error={showError ? state.error : undefined}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" loading={pending}>
          Simpan
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setEditing(false);
            requestAnimationFrame(() => toggleRef.current?.focus());
          }}
        >
          Batal
        </Button>
      </div>
    </form>
  );
}
