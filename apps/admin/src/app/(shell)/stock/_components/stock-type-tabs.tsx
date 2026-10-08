import { Tabs } from "@ammari/ui";

const TABS = [
  { label: "Barang jadi", href: "/stock" },
  { label: "Kain", href: "/stock/fabrics" },
  { label: "Aksesoris", href: "/stock/accessories" },
] as const;

/** Route-level tabs across three distinct pages (not one page filtered by a query param, so
 * `FilterTabs` doesn't fit — see its own doc comment) — renders through the same shared `Tabs`
 * component every other tab row on the admin uses, so they all look and behave identically.
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
  const items = visibleTabs.map((tab) => ({ label: tab.label, href: tab.href, isActive: tab.label === active }));
  return <Tabs items={items} aria-label="Jenis stok" />;
}
