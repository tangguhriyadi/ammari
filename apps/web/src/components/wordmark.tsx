import Image from "next/image";
import { cn } from "@ammari/ui";

export type WordmarkTone = "primary" | "white";

export interface WordmarkProps {
  className?: string;
  /** Footer renders it larger (26px) and white-on-brand; header renders it 22px, brand-on-white
   * (docs/design/storefront.md §3 "Wordmark"). */
  size?: "header" | "footer";
  /** Which logo mark to render: "primary" (the brand-coloured mark, for the header's white
   * background) or "white" (for the footer's `--color-brand` background). Every call site today
   * only ever varies this together with `size` (header -> primary, footer -> white), so it
   * defaults to following `size` the same way the text colour already does — pass it explicitly
   * only if a future call site needs to decouple the two. */
  tone?: WordmarkTone;
}

const LOGO_SRC: Record<WordmarkTone, string> = {
  primary: "/logos/ammari-primary.png",
  white: "/logos/ammari-white.png",
};

// The DISPLAYED height for each size (roughly matching the wordmark's cap height — 22px/26px
// text — without the logo reading oversized next to it). Must match
// packages/ui/assets/copy-brand-logos.mjs's own LARGEST_DISPLAY_HEIGHT_PX constant (that script
// renders the generated logo files at 4x this value, for crisp 2x/3x-DPI phone screens) — update
// both together.
const LOGO_DISPLAY_HEIGHT: Record<NonNullable<WordmarkProps["size"]>, number> = {
  header: 24,
  footer: 28,
};

// The generated logo files' own real pixel dimensions (copy-brand-logos.mjs's console output,
// not a 1:1 square like the 1254x1254 source — trimming the source's transparent padding before
// resizing leaves this aspect ratio). Passed to next/image as the intrinsic width/height (so its
// automatic `aspect-ratio` CSS is correct), while `style` below scales the actual displayed size
// down to LOGO_DISPLAY_HEIGHT with `width: "auto"` to preserve that ratio exactly — re-run that
// script and update this constant together if the source art ever changes.
const LOGO_INTRINSIC_SIZE = { width: 94, height: 112 };

/** Temporary text wordmark (docs/design/storefront.md §9): the Alta font is not licensed yet, so
 * "AMMARI" renders as Cormorant Garamond 700 with wide letter-spacing. The logo mark added
 * alongside it is the real Ammari brand mark (not a placeholder) — isolated in its own component
 * so swapping the text for a licensed SVG wordmark later touches this one file, not every page
 * that renders the brand. Never add an Alta font file to the repo. */
export function Wordmark({ className, size = "header", tone }: WordmarkProps) {
  const resolvedTone = tone ?? (size === "footer" ? "white" : "primary");
  const displayHeight = LOGO_DISPLAY_HEIGHT[size];
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Image
        src={LOGO_SRC[resolvedTone]}
        alt=""
        width={LOGO_INTRINSIC_SIZE.width}
        height={LOGO_INTRINSIC_SIZE.height}
        className="shrink-0"
        style={{ height: displayHeight, width: "auto" }}
      />
      <span
        className={cn(
          "font-serif font-bold tracking-[0.34em]",
          size === "header" ? "text-[22px] text-brand" : "text-[26px] text-footer-text",
        )}
      >
        AMMARI
      </span>
    </span>
  );
}
