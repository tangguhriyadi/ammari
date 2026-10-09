"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@ammari/ui";
import type { PrintableCard } from "../actions";
import { THANK_YOU_CARD_MESSAGE } from "@/lib/packing/card-copy";

type Layout = "a6" | "a4x4";

export function PrintCardsOverlay({ cards, onClose }: { cards: PrintableCard[]; onClose: () => void }) {
  const [layout, setLayout] = useState<Layout>("a4x4");
  // Incremented (never just a boolean) so clicking "Cetak" again after an earlier print/cancel
  // re-triggers the effect below even though its value was already non-zero once.
  const [printRequest, setPrintRequest] = useState(0);

  // Closes the overlay once the print dialog is dismissed — fires whether the staffer actually
  // printed or cancelled, so there's nothing left for them to manually close afterward.
  useEffect(() => {
    window.addEventListener("afterprint", onClose);
    return () => window.removeEventListener("afterprint", onClose);
  }, [onClose]);

  // `window.print()` must never fire synchronously from the "Cetak" button's own click handler:
  // calling it immediately after a just-committed state change (this overlay's own initial
  // mount, or a layout-radio switch) can race the browser's next paint — Chrome/WebKit still
  // show a print dialog, but the snapshot they print from can be a stale or not-yet-laid-out
  // frame, which is exactly how a real "Cetak" click produced a completely blank PDF even though
  // the cards were clearly visible on screen a moment later. A click instead bumps
  // `printRequest`, and this layout effect — scheduled as early as possible after the commit —
  // waits two animation frames (the standard guarantee that an actual paint has happened: the
  // first rAF still runs BEFORE the upcoming paint, the second only runs AFTER it) and for every
  // web font to finish loading (the AMMARI wordmark uses a custom font — packages/ui/src/fonts)
  // before calling the real `window.print()`.
  useLayoutEffect(() => {
    if (printRequest === 0) return;
    let cancelled = false;
    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        document.fonts.ready.then(() => {
          if (!cancelled) window.print();
        });
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
    };
  }, [printRequest]);

  // Portaled straight to <body> (outside the admin shell's own tree) specifically so printing
  // can hide EVERY other body child with one blanket rule (`#print-root` in globals.css) instead
  // of chasing down the shell header, sidebar/bottom nav, the page's own list, and any open
  // Dialog individually — the "whole page prints, card lands on page 2" bug this fixes happened
  // because this overlay used to render inline inside the page's own tree, where `print:hidden`
  // only ever reached the pieces someone remembered to mark.
  return createPortal(
    <div id="print-root" className="fixed inset-0 z-50 overflow-y-auto bg-white print:static print:overflow-visible">
      {/* `margin: 0` on every layout — the browser's own print margin is where the UA's default
          header/footer (date, page title, URL, page numbers) live; removing it removes those for
          free, and each card supplies its own internal padding instead. `size: A4` only for the
          4-per-A4 layout, where the 2x2 grid genuinely needs A4 to fit as designed — the "1 per
          lembar" layout leaves paper size to the OS print dialog (docs/plans/packing-cards.md):
          the card box itself is always the real 105x148mm either way, so staff feeding pre-cut A6
          stock just pick that size there. */}
      <style>{layout === "a4x4" ? "@page { size: A4; margin: 0; }" : "@page { margin: 0; }"}</style>
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 bg-white p-4 print:hidden">
        <div className="flex items-center gap-3">
          <p className="text-base font-medium text-neutral-900">{cards.length} kartu siap dicetak</p>
          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input type="radio" name="print-layout" checked={layout === "a4x4"} onChange={() => setLayout("a4x4")} />
            4 per lembar A4
          </label>
          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input type="radio" name="print-layout" checked={layout === "a6"} onChange={() => setLayout("a6")} />
            1 per lembar
          </label>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>
            Tutup
          </Button>
          <Button onClick={() => setPrintRequest((n) => n + 1)}>Cetak</Button>
        </div>
      </div>

      <div className={layout === "a4x4" ? "grid grid-cols-2 justify-center gap-0 p-4 print:p-0" : "flex flex-col items-center gap-4 p-4 print:gap-0 print:p-0"}>
        {cards.map((card, index) => (
          <div
            key={card.orderId}
            // `break-inside-avoid` on top of the `breakAfter` paging below — a card landing right
            // at a page boundary must never have ITS OWN content split across the two pages.
            // Cut guides are dashed only for the 4-per-A4 grid, where staff actually cut between
            // cards; the 1-per-sheet layout keeps a plain solid edge (nothing to cut between).
            className={`box-border flex w-[105mm] shrink-0 break-inside-avoid flex-col items-center justify-between p-[6mm] text-center ${
              layout === "a4x4" ? "border border-dashed border-neutral-400" : "border border-neutral-200 print:border-neutral-300"
            }`}
            style={{ height: "148mm", breakAfter: layout === "a4x4" ? (index % 4 === 3 ? "page" : "auto") : "page" }}
          >
            <span className="font-serif text-2xl font-light tracking-[0.2em] text-brand">AMMARI</span>
            <div className="flex flex-col gap-2">
              <p className="text-base font-medium text-neutral-900">{THANK_YOU_CARD_MESSAGE.greeting(card.buyerName)}</p>
              {/* No layout dependence on the 🤍 glyph (owner's rule) — plain text flow, never
                  sized/positioned relative to it; if a print driver drops the emoji, every line
                  around it still reads fine. */}
              {THANK_YOU_CARD_MESSAGE.body.map((line) => (
                <p key={line} className="text-sm text-neutral-700">
                  {line}
                </p>
              ))}
            </div>
            {/* Server-generated SVG from the trusted `qrcode` package, built from our own URL
                (never raw user input) — see packing/actions.ts's printThankYouCardsAction. */}
            <div className="size-[32mm]" dangerouslySetInnerHTML={{ __html: card.qrSvg }} />
            <div className="flex flex-col gap-1">
              {THANK_YOU_CARD_MESSAGE.qrHint.map((line) => (
                <p key={line} className="text-sm text-neutral-700">
                  {line}
                </p>
              ))}
              <p className="text-sm font-medium text-neutral-900">{card.claimUrlHost}</p>
              {/* The grouped code on its own line, monospace with wide tracking so each 4-char
                  group reads clearly, and `whitespace-nowrap` so a group is never split across a
                  line break (the card is wide enough at 105mm for the whole 34-character string
                  to fit on one line regardless). */}
              <p className="whitespace-nowrap font-mono text-sm font-medium tracking-widest text-neutral-900">
                {card.claimTokenDisplay}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
