"use client";

import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { NavLink, type NavLinkItem } from "./nav-link";
import { MoreSheet } from "./more-sheet";

export function BottomNav({
  primaryItems,
  remainingItems,
}: {
  primaryItems: readonly NavLinkItem[];
  remainingItems: readonly NavLinkItem[];
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const slotCount = primaryItems.length + (remainingItems.length > 0 ? 1 : 0);

  return (
    <>
      <nav
        aria-label="Navigasi utama"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-neutral-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <ul className="grid" style={{ gridTemplateColumns: `repeat(${slotCount}, minmax(0, 1fr))` }}>
          {primaryItems.map((item) => (
            <li key={item.href}>
              <NavLink href={item.href} label={item.label} icon={item.icon} variant="bottom" />
            </li>
          ))}
          {remainingItems.length > 0 && (
            <li>
              <button
                type="button"
                onClick={() => setMoreOpen(true)}
                className="flex min-h-14 w-full flex-col items-center justify-center gap-0.5 text-xs font-medium text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
              >
                <MoreHorizontal aria-hidden="true" className="size-5" />
                Lainnya
              </button>
            </li>
          )}
        </ul>
      </nav>
      <MoreSheet open={moreOpen} onOpenChange={setMoreOpen} items={remainingItems} />
    </>
  );
}
