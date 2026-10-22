"use client";

import { useActionState } from "react";
import { Button } from "@ammari/ui";
import { claimAction, type ClaimActionState } from "./actions";

const initialState: ClaimActionState = { status: "idle" };

/** A successful claim never comes back here: the action redirects to the homepage collection
 * (lib/claim/claimed-notice.ts), so this only ever renders the button and a rejection message. */
export function ClaimForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(claimAction, initialState);

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
