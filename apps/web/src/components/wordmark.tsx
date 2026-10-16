import { cn } from "@ammari/ui";

export interface WordmarkProps {
  className?: string;
  /** Footer renders it larger (26px) and white-on-brand; header renders it 22px, brand-on-white
   * (docs/design/storefront.md §3 "Wordmark"). */
  size?: "header" | "footer";
}

/** Temporary wordmark (docs/design/storefront.md §9): the Alta font is not licensed yet, so
 * "AMMARI" renders as Cormorant Garamond 400 with wide letter-spacing instead. Isolated in its
 * own component so swapping in a licensed SVG logo later touches this one file, not every page
 * that renders the brand name. Never add an Alta font file to the repo. */
export function Wordmark({ className, size = "header" }: WordmarkProps) {
  return (
    <span
      className={cn(
        "font-serif font-normal tracking-[0.34em]",
        size === "header" ? "text-[22px] text-brand" : "text-[26px] text-footer-text",
        className,
      )}
    >
      AMMARI
    </span>
  );
}
