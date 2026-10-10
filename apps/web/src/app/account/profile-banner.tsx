"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { Button, Card } from "@ammari/ui";

const DISMISS_KEY = "ammari_profile_banner_dismissed";

// A tiny external store over sessionStorage: `dismiss()` is both the only writer and the thing
// that notifies `useSyncExternalStore` to re-read `getSnapshot()` — this is what makes clicking
// "Nanti saja" hide the banner immediately, not just on some later unrelated re-render.
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function getSnapshot(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) !== "1";
  } catch {
    return true; // private window / blocked storage — show it rather than throw
  }
}

function getServerSnapshot(): boolean {
  return false; // no sessionStorage on the server — matches the dismissed/hidden state
}

function dismiss(): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // ignore — per-viewer convenience only, not state that needs to persist reliably
  }
  for (const listener of listeners) listener();
}

/** Dismissible-per-session (docs/SPEC.md §10.3) — `sessionStorage`, not a DB flag, so it comes
 * back if the customer opens a new tab/session, and never has to be read back by the server.
 * `useSyncExternalStore` (not a plain `useEffect` + `setState`, which `eslint-plugin-react-
 * hooks`' `set-state-in-effect` rule now flags) is the React-sanctioned way to read a
 * browser-only store like this: the server/first-client-paint snapshot is "hidden" by
 * construction (no hydration-mismatch warning), and it resyncs to the real value right after
 * hydration through the mechanism React actually intends for this. */
export function ProfileBanner() {
  const visible = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (!visible) return null;

  return (
    <Card className="flex flex-col gap-3 border-warning-200 bg-warning-50">
      <p className="text-sm text-neutral-900">Lengkapi profilmu agar lebih mudah dihubungi.</p>
      <div className="flex gap-2">
        <Link href="/account/complete-profile">
          <Button variant="secondary">Lengkapi profil</Button>
        </Link>
        <Button variant="ghost" onClick={dismiss}>
          Nanti saja
        </Button>
      </div>
    </Card>
  );
}
