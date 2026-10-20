"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { OPEN_ACCORDION_EVENT, type OpenAccordionDetail } from "./size-guide";
import { Minus, Plus } from "lucide-react";

export interface AccordionItemDef {
  id: string;
  title: string;
  content: ReactNode;
}

/** docs/design/storefront.md §6 item 9 — one open at a time, "Deskripsi" open by default, `+`/`−`,
 * `aria-expanded`. The size picker's "Panduan ukuran" link is an `<a href="#ukuran">` (works
 * without JS; the hash also opens the Ukuran panel on mount, effect below) that, with JS, fires
 * `OPEN_ACCORDION_EVENT` instead of the native jump: this component opens the panel, waits for
 * layout, then smooth-scrolls to and focuses the size chart heading. */
export function Accordions({ items }: { items: AccordionItemDef[] }) {
  const [openId, setOpenId] = useState<string | null>(items[0]?.id ?? null);
  const baseId = useId();

  // Syncs from a non-reactive browser API (the URL hash left by the "Panduan ukuran" link's
  // plain `<a href="#ukuran">` jump) that has no SSR-safe way to read during the initial render —
  // a legitimate exception to the "don't setState in an effect" rule, not a mirror of state React
  // already owns. Only on mount — this isn't a router that re-reads the hash on every navigation
  // within the page.
  useEffect(() => {
    if (window.location.hash === "#ukuran" && items.some((item) => item.id === "ukuran")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpenId("ukuran");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Panduan ukuran" (product-purchase-panel.tsx) asks for an accordion to be opened and one of
  // its elements brought into view. Opening can reflow the page (a different panel closes above
  // it), so the scroll happens only AFTER the new layout has been committed and painted.
  const [scrollRequest, setScrollRequest] = useState<{ targetId: string; n: number } | null>(null);

  useEffect(() => {
    function handleOpen(event: Event) {
      const { accordionId, targetId } = (event as CustomEvent<OpenAccordionDetail>).detail;
      if (!items.some((item) => item.id === accordionId)) return;
      setOpenId(accordionId);
      setScrollRequest((previous) => ({ targetId, n: (previous?.n ?? 0) + 1 }));
    }
    window.addEventListener(OPEN_ACCORDION_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_ACCORDION_EVENT, handleOpen);
  }, [items]);

  useEffect(() => {
    if (!scrollRequest) return;
    let frame = requestAnimationFrame(() => {
      // Second frame: the first runs before the browser has laid out the just-opened panel.
      frame = requestAnimationFrame(() => {
        const target = document.getElementById(scrollRequest.targetId);
        if (!target) return;
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        // The target's `scroll-mt` class keeps it clear of the sticky header.
        target.scrollIntoView({ behavior: reduceMotion ? "instant" : "smooth", block: "start" });
        // preventScroll: the scroll above is the only one, no second jump from focus().
        target.focus({ preventScroll: true });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollRequest]);

  return (
    <div className="flex flex-col">
      {items.map((item) => {
        const isOpen = openId === item.id;
        const panelId = `${baseId}-panel-${item.id}`;
        const triggerId = `${baseId}-trigger-${item.id}`;
        return (
          <div key={item.id} id={item.id} className="border-b border-line">
            <button
              type="button"
              id={triggerId}
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => setOpenId(isOpen ? null : item.id)}
              className="flex min-h-11 w-full items-center justify-between gap-4 py-4 text-left text-xs font-medium tracking-[0.1em] text-ink uppercase"
            >
              {item.title}
              {isOpen ? <Minus className="size-4 shrink-0" strokeWidth={1.4} aria-hidden="true" /> : <Plus className="size-4 shrink-0" strokeWidth={1.4} aria-hidden="true" />}
            </button>
            {isOpen && (
              <div id={panelId} role="region" aria-labelledby={triggerId} className="pb-5 text-sm text-ink-soft">
                {item.content}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
