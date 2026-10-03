import { cn } from "../lib/cn";

export interface ColorSwatchProps {
  /** `^#[0-9A-F]{6}$` (fabric_colors.hex's own format) or `null` — a color with no hex shows a
   * neutral, un-colored placeholder circle (the CHECK constraint's own documented default), not
   * an error state. */
  hex: string | null;
  className?: string;
}

/** The ONE place a fabric color's hex becomes a rendered swatch — used by the product photo
 * section, the variant builder, and the fabric colors list. A dynamic hex can only ever be
 * applied via inline `style`, never a Tailwind class: Tailwind's compiler only generates CSS
 * for class strings it can see literally in the source at build time, so something like
 * `` className={`bg-[${hex}]`} `` would silently produce no styling at all for a runtime value
 * (this was investigated as a real root-cause candidate for an owner-reported "empty swatch"
 * bug; this component was extracted partly so that mistake can only ever happen in one place,
 * covered by ColorSwatch.test.tsx, instead of being free to silently diverge across three
 * separate copies). */
export function ColorSwatch({ hex, className }: ColorSwatchProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-5 shrink-0 rounded-full border border-neutral-300", className)}
      style={{ backgroundColor: hex ?? undefined }}
    />
  );
}
