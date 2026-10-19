import { Tabs } from "@ammari/ui";

const TABS = [
  { label: "Barang jadi", href: "/stock" },
  { label: "Kain", href: "/stock/fabrics" },
  { label: "Aksesoris", href: "/stock/accessories" },
  { label: "Cacat", href: "/stock/defects" },
] as const;

/** Route-level tabs across three distinct pages (not one page filtered by a query param, so
 * `FilterTabs` doesn't fit — see its own doc comment) — renders through the same shared `Tabs`
 * component every other tab row on the admin uses, so they all look and behave identically.
 *
 * `/stock` and `/stock/{fabrics,accessories}` sit behind two INDEPENDENT permission keys
 * (`stock.view` vs `inventory.view` — see lib/nav/config.ts, where the main sidebar already
 * gates "Stok" and "Pembelian"/"Aksesoris" separately for exactly this reason: a role can hold
 * one without the other). Rendering a tab the current session can't actually follow would dangle
 * a link that 403s on click, so each caller tells this component which of the two it can show.
 * "Cacat" (/stock/defects, S5) spans both kinds and opens with EITHER key, each section of that
 * page gated by its own. */
export function StockTypeTabs({
  active,
  canViewFinishedGoods,
  canViewRawMaterials,
}: {
  active: (typeof TABS)[number]["label"];
  canViewFinishedGoods: boolean;
  canViewRawMaterials: boolean;
}) {
  const visibleTabs = TABS.filter((tab) => {
    if (tab.label === "Barang jadi") return canViewFinishedGoods;
    if (tab.label === "Cacat") return canViewFinishedGoods || canViewRawMaterials;
    return canViewRawMaterials;
  });
  const items = visibleTabs.map((tab) => ({ label: tab.label, href: tab.href, isActive: tab.label === active }));
  return <Tabs items={items} aria-label="Jenis stok" />;
}
