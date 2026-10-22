"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { VOUCHER_CLAIMED_PARAM, VOUCHER_CLAIMED_VALUE } from "@/lib/claim/claimed-notice";

const DISMISS_AFTER_MS = 8000;

/** The one-time "Voucher sudah masuk ke akunmu" notice the homepage shows after a successful
 * claim (lib/claim/claimed-notice.ts; `message` is built on the server, with the voucher's dates
 * when they could be read). The live region is in the server HTML but empty; the text
 * goes in after mount, so screen readers announce it (a region that arrives already filled is
 * often not read). On mount the `?voucher=claimed` param is dropped from the address, keeping the
 * `#koleksi` hash, so a refresh or a shared link never shows it again. It shows only while the
 * address still carries the param: a later remount of the same cached tree (Back/Forward through
 * the router cache, whose server payload still says "claimed") finds it gone and stays empty.
 * The auto-dismiss waits while the pointer or focus is inside, so "Lihat akun" never vanishes
 * under a keyboard or screen-reader user. */
export function VoucherClaimedNotice({ message }: { message: string }) {
  const [visible, setVisible] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get(VOUCHER_CLAIMED_PARAM) !== VOUCHER_CLAIMED_VALUE) return;
    url.searchParams.delete(VOUCHER_CLAIMED_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    // Mount-only reveal from a browser-only signal (the address, see the doc comment), not
    // mirrored state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(true);
  }, []);

  useEffect(() => {
    if (!visible || paused) return;
    const timer = window.setTimeout(() => setVisible(false), DISMISS_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [visible, paused]);

  return (
    <div role="status" className="pointer-events-none fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-50 flex justify-center">
      {visible && (
        <div
          data-testid="voucher-claimed-notice"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
          }}
          className="pointer-events-auto flex w-full max-w-sm items-center gap-3 bg-brand py-1 pr-1 pl-4 text-sm text-white shadow-lg"
        >
          <p className="flex flex-1 flex-wrap items-center gap-x-2">
            <span>{message}</span>
            <Link href="/account" className="inline-flex min-h-11 items-center underline underline-offset-4">
              Lihat akun
            </Link>
          </p>
          <button
            type="button"
            aria-label="Tutup pemberitahuan"
            onClick={() => setVisible(false)}
            className="inline-flex size-11 shrink-0 items-center justify-center"
          >
            <X className="size-4" strokeWidth={1.4} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
