"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CART_COUNT_EVENT, CART_COUNT_PATH, type CartCountDetail } from "@/lib/cart/count-event";

/** The header's cart icon (docs/design/storefront.md §4, rendered only while the cart flag is on).
 * The count is fetched per page from the uncached count route, never rendered on the server: the
 * layout around it is part of ISR-cached pages. Re-fetched on every navigation (a login may have
 * merged a guest cart in the meantime) and updated straight away when a cart write announces its
 * new count, and again when the page comes back from the back/forward cache (another tab may
 * have changed the cart). Until the first answer, and if the fetch fails, the bag shows without a
 * number. A 404 means the flag was switched off while this page's cached HTML still carries the
 * icon: the icon then hides itself instead of linking to a missing page. */
export function CartLink() {
  const pathname = usePathname();
  const [pieceCount, setPieceCount] = useState<number | null>(null);
  const [disabled, setDisabled] = useState(false);
  // Bumped by a back/forward-cache restore to re-run the fetch below.
  const [restoreCount, setRestoreCount] = useState(0);
  // Bumped by every announced count, so a fetch that started before a cart write cannot
  // overwrite the newer count when it resolves late.
  const announcements = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const startedAt = announcements.current;
    fetch(CART_COUNT_PATH, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) {
          setDisabled(true);
          return;
        }
        if (!response.ok) throw new Error(`cart count answered ${response.status}`);
        const body = (await response.json()) as { pieceCount?: unknown };
        if (announcements.current !== startedAt) return;
        if (typeof body.pieceCount === "number") setPieceCount(body.pieceCount);
      })
      .catch((error: unknown) => {
        // A newer navigation aborted it: nothing to report. Anything else keeps what is shown.
        if (error instanceof Error && error.name === "AbortError") return;
        console.warn("[cart] header count unavailable", error);
      });
    return () => controller.abort();
  }, [pathname, restoreCount]);

  useEffect(() => {
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) setRestoreCount((value) => value + 1);
    }
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  useEffect(() => {
    function handleCount(event: Event) {
      announcements.current += 1;
      setPieceCount((event as CustomEvent<CartCountDetail>).detail.pieceCount);
    }
    window.addEventListener(CART_COUNT_EVENT, handleCount);
    return () => window.removeEventListener(CART_COUNT_EVENT, handleCount);
  }, []);

  if (disabled) return null;
  const count = pieceCount ?? 0;
  return (
    <Link
      href="/cart"
      aria-label={count > 0 ? `Keranjang, ${count} barang` : "Keranjang"}
      className="relative flex size-11 items-center justify-center text-ink hover:text-ink-muted"
    >
      <BagIcon />
      {count > 0 && (
        <span
          data-testid="cart-count"
          aria-hidden="true"
          // A notification badge on the bag's upper right corner: the 20px bag sits centred in the
          // 44px box (x 12 to 32, y 12 to 32), the badge's centre near (31, 13). Anchored on its
          // left edge so "9+" grows outward, away from the icon.
          className="absolute top-[6px] left-[24px] flex h-4 min-w-4 items-center justify-center rounded-full bg-badge px-1 text-[10px] leading-none font-medium text-white tabular-nums"
        >
          {badgeLabel(count)}
        </span>
      )}
    </Link>
  );
}

/** The badge shows at most "9+"; the accessible name keeps the exact count. */
export function badgeLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}

/** A plain shopping bag: body with the handle above it, nothing inside (owner choice 2026-10-21,
 * replacing lucide's ShoppingBag whose inner curve read as a smile). Drawn like a lucide icon
 * (24 grid, round joins) with the account icon's 1.4 stroke. */
function BagIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="4.5" y="8" width="15" height="13" />
      <path d="M8.5 8V6.5a3.5 3.5 0 0 1 7 0V8" />
    </svg>
  );
}
