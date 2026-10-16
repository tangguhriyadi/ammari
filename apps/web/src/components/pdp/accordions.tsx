"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";

export interface AccordionItemDef {
  id: string;
  title: string;
  content: ReactNode;
}

/** docs/design/storefront.md §6 item 9 — one open at a time, "Deskripsi" open by default, `+`/`−`,
 * `aria-expanded`. The size picker's "Panduan ukuran" link is a plain `<a href="#ukuran">` (see
 * product-purchase-panel.tsx) — the browser's native anchor jump scrolls here, and the effect
 * below opens the Ukuran panel specifically when that's the hash on mount, without any
 * cross-component state coordination. */
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
