"use client";

import { useEffect, useState } from "react";
import { STALE_PAGE_MESSAGE, scheduleStaleReload } from "@/lib/stale-deployment";
import { PrimaryButton } from "@/components/buttons";

/** What an error boundary shows for a page from the previous build (lib/stale-deployment.ts): the
 * message, and the page reloads itself once; the button stays for a page that is still stale. */
export function StalePageNotice() {
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    // Only ever to true: StrictMode's second run hits the loop guard, and a reload is still coming.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads sessionStorage, browser only
    if (scheduleStaleReload()) setReloading(true);
  }, []);

  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-6 px-4 py-10">
      <p role="alert" className="text-sm text-ink" data-testid="stale-page-notice">
        {STALE_PAGE_MESSAGE}
      </p>
      <PrimaryButton onClick={() => window.location.reload()} className="w-full md:w-auto">
        {reloading ? "Memuat ulang..." : "Muat ulang"}
      </PrimaryButton>
    </div>
  );
}
