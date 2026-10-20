"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { OPEN_ACCORDION_EVENT, type OpenAccordionDetail } from "./size-guide";
import { Minus, Plus } from "lucide-react";
import { Curtain } from "@/components/curtain";

export interface AccordionItemDef {
  id: string;
  title: string;
  content: ReactNode;
}

/** docs/design/storefront.md §6 item 9 — one open at a time, "Deskripsi" open by default, `+`/`−`,
 * `aria-expanded`. The size picker's "Panduan ukuran" link is an `<a href="#ukuran">` (works
 * without JS; the hash also opens the Ukuran panel on mount, effect below) that, with JS, fires
 * `OPEN_ACCORDION_EVENT` instead of the native jump: this component opens the panel, waits for
 * its open animation to finish, then smooth-scrolls to and focuses the size chart heading.
 * Panels unroll and roll back up through Curtain (instant under reduced motion). */
export function Accordions({ items }: { items: AccordionItemDef[] }) {
  const [openId, setOpenId] = useState<string | null>(items[0]?.id ?? null);
  const baseId = useId();
  // The open panel as of the latest change (read by the window event listener), the panel that
  // has finished opening (null while one is animating or none is open), and a "Panduan ukuran"
  // request waiting for its panel to finish opening.
  const openIdRef = useRef(openId);
  const settledOpenIdRef = useRef<string | null>(openId);
  const pendingScrollRef = useRef<OpenAccordionDetail | null>(null);

  // Every open/close goes through here. "Settled" is reset only on an actual change: re-opening
  // the panel that is already open starts no transition, so no onOpened would ever re-set it.
  function changeOpenId(next: string | null) {
    if (next === openIdRef.current) return;
    openIdRef.current = next;
    settledOpenIdRef.current = null;
    setOpenId(next);
  }

  // Syncs from a non-reactive browser API (the URL hash left by the "Panduan ukuran" link's
  // plain `<a href="#ukuran">` jump) that has no SSR-safe way to read during the initial render —
  // a legitimate exception to the "don't setState in an effect" rule, not a mirror of state React
  // already owns. Only on mount — this isn't a router that re-reads the hash on every navigation
  // within the page.
  useEffect(() => {
    if (window.location.hash === "#ukuran" && items.some((item) => item.id === "ukuran")) {
      changeOpenId("ukuran");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Panduan ukuran" (product-purchase-panel.tsx) asks for an accordion to be opened and one of
  // its elements brought into view. The scroll waits until that panel has finished unrolling
  // (Curtain's onOpened: transitionend, or its timeout fallback), since its final height and the
  // closing of whichever panel was open above it both move the target. Already fully open: the
  // scroll happens right away.
  useEffect(() => {
    function handleOpen(event: Event) {
      const detail = (event as CustomEvent<OpenAccordionDetail>).detail;
      if (!items.some((item) => item.id === detail.accordionId)) return;
      if (settledOpenIdRef.current === detail.accordionId) {
        pendingScrollRef.current = null;
        scrollToTarget(detail.targetId);
        return;
      }
      // Not open yet, or still unrolling: scroll once it has finished.
      pendingScrollRef.current = detail;
      changeOpenId(detail.accordionId);
    }
    window.addEventListener(OPEN_ACCORDION_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_ACCORDION_EVENT, handleOpen);
  }, [items]);

  function toggle(id: string) {
    // The user took over: a size-guide request still waiting must not fire later, e.g. when they
    // reopen Ukuran by hand after closing it mid-animation.
    pendingScrollRef.current = null;
    changeOpenId(openIdRef.current === id ? null : id);
  }

  function handleOpened(id: string) {
    settledOpenIdRef.current = id;
    const pending = pendingScrollRef.current;
    if (pending?.accordionId !== id) return;
    pendingScrollRef.current = null;
    scrollToTarget(pending.targetId);
  }

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
              onClick={() => toggle(item.id)}
              className="flex min-h-11 w-full items-center justify-between gap-4 py-4 text-left text-xs font-medium tracking-[0.1em] text-ink uppercase"
            >
              {item.title}
              {isOpen ? <Minus className="size-4 shrink-0" strokeWidth={1.4} aria-hidden="true" /> : <Plus className="size-4 shrink-0" strokeWidth={1.4} aria-hidden="true" />}
            </button>
            <Curtain
              open={isOpen}
              id={panelId}
              role="region"
              aria-labelledby={triggerId}
              contentClassName="pb-5 text-sm text-ink-soft"
              onOpened={() => handleOpened(item.id)}
            >
              {item.content}
            </Curtain>
          </div>
        );
      })}
    </div>
  );
}

function scrollToTarget(targetId: string) {
  // One frame so a just-settled layout (the panel's clip lifted, a closed panel unmounted) is in.
  requestAnimationFrame(() => {
    const target = document.getElementById(targetId);
    if (!target) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Measure the destination with instant jumps (the target's `scroll-mt` class keeps it clear
    // of the sticky header), then glide there from where the page was. On desktop the target
    // sits in the sticky purchase column, and scrollIntoView computes its end point as if that
    // column scrolled with the page: one pass (smooth or instant) stops short with the chart
    // near the bottom of the viewport, so the instant jump repeats until the page stops moving.
    // All of it runs in one task, so nothing is painted in between.
    const startY = window.scrollY;
    for (let pass = 0; pass < 4; pass++) {
      const before = window.scrollY;
      target.scrollIntoView({ behavior: "instant", block: "start" });
      if (window.scrollY === before) break;
    }
    if (!reduceMotion) {
      const endY = window.scrollY;
      window.scrollTo({ top: startY, behavior: "instant" });
      window.scrollTo({ top: endY, behavior: "smooth" });
    }
    // preventScroll: the scroll above is the only one, no second jump from focus().
    target.focus({ preventScroll: true });
  });
}
