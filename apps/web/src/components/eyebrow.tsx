import { cn } from "@ammari/ui";

/** docs/design/storefront.md §3 "Eyebrow / labels" — Jost 11px/500, letter-spacing 0.24em,
 * uppercase. e.g. "KOLEKSI PERDANA", "KEUNGGULAN". */
export function Eyebrow({ className, children }: { className?: string; children: string }) {
  return <p className={cn("text-[11px] font-medium tracking-[0.24em] text-brand uppercase", className)}>{children}</p>;
}
