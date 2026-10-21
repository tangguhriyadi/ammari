"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@ammari/ui";

/** The "Masuk" button: a plain HTML form POST (works without JavaScript), sent once. A second tap
 * while the first request is under way would post the already-used token and land on "Link sudah
 * tidak berlaku" after a successful login, so it is swallowed (the busy button is also disabled; the
 * check here covers a submit by Enter before the re-render). Coming back to the page from the
 * back/forward cache re-enables the button. */
export function LoginLinkForm({ action, token }: { action: string; token: string }) {
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setSubmitting(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (submitting) {
      event.preventDefault();
      return;
    }
    setSubmitting(true);
  }

  return (
    <form method="post" action={action} onSubmit={onSubmit} className="flex w-full flex-col">
      <input type="hidden" name="token" value={token} />
      <Button type="submit" loading={submitting}>
        Masuk
      </Button>
    </form>
  );
}
