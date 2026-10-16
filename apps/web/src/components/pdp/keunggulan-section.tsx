import type { ProductHighlightView } from "@/lib/content/product-view";
import { PRODUCT_HIGHLIGHT_ICONS } from "@/lib/content/icons";
import { Eyebrow } from "@/components/eyebrow";

const NUMERALS = ["01", "02", "03", "04", "05"];

/** docs/design/storefront.md §6 item 8 — eyebrow "KEUNGGULAN", numbered rows 01–05 (Cormorant
 * numeral in brand colour + label + icon), canonical key order, hairline between rows. */
export function KeunggulanSection({ highlights }: { highlights: ProductHighlightView[] }) {
  if (highlights.length === 0) return null;

  return (
    <section className="flex flex-col gap-4 py-6">
      <Eyebrow>Keunggulan</Eyebrow>
      <ul className="flex flex-col">
        {highlights.map((highlight, index) => {
          const Icon = PRODUCT_HIGHLIGHT_ICONS[highlight.key];
          return (
            <li key={highlight.key} className="flex items-center gap-4 border-b border-line py-3 first:pt-0 last:border-b-0">
              <span className="font-serif text-lg text-brand">{NUMERALS[index] ?? String(index + 1).padStart(2, "0")}</span>
              <span className="text-[15px] text-ink">{highlight.label}</span>
              <Icon className="ml-auto size-5 shrink-0 text-ink-muted" strokeWidth={1.4} aria-hidden="true" />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
