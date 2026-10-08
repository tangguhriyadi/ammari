import Link from "next/link";
import { cn } from "@ammari/ui";

const TABS = [
  { label: "Barang jadi", href: "/stock" },
  { label: "Kain", href: "/stock/fabrics" },
  { label: "Aksesoris", href: "/stock/accessories" },
] as const;

/** Route-level tabs across three distinct pages (not one page filtered by a query param, so
 * `FilterTabs` doesn't fit — see its own doc comment) — same plain-navigation-link reasoning:
 * `aria-current`, not the ARIA tabs pattern.
 *
 * `/stock` and `/stock/{fabrics,accessories}` sit behind two INDEPENDENT permission keys
 * (`stock.view` vs `inventory.view` — see lib/nav/config.ts, where the main sidebar already
 * gates "Stok" and "Pembelian"/"Aksesoris" separately for exactly this reason: a role can hold
 * one without the other). Rendering a tab the current session can't actually follow would dangle
 * a link that 403s on click, so each caller tells this component which of the two it can show. */
export function StockTypeTabs({
  active,
  canViewFinishedGoods,
  canViewRawMaterials,
}: {
  active: "Barang jadi" | "Kain" | "Aksesoris";
  canViewFinishedGoods: boolean;
  canViewRawMaterials: boolean;
}) {
  const visibleTabs = TABS.filter((tab) => (tab.label === "Barang jadi" ? canViewFinishedGoods : canViewRawMaterials));
  return (
    <nav aria-label="Jenis stok" className="mb-4 flex gap-2 overflow-x-auto">
      {visibleTabs.map((tab) => {
        const isActive = tab.label === active;
        return (
          <Link
            key={tab.label}
            href={tab.href}
            aria-current={isActive ? "true" : undefined}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-base font-medium transition-colors",
              isActive ? "bg-brand text-brand-foreground" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
