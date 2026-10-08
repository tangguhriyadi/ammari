import type { BreadcrumbItem } from "@ammari/ui";
import { NAV_ITEMS } from "./config";

/** The group + nav-item crumbs for a top-level menu page, e.g. `rootCrumbs("/products")` ->
 * `[{ label: "Katalog" }, { label: "Produk", href: "/products" }]`. Pages add their own
 * trailing crumbs (a sub-page label, or a loaded entity's name/number) after this. Throws if
 * `href` isn't in NAV_ITEMS — every (shell) page lives under one of them, so a miss here is a
 * typo in the caller, not a runtime condition to handle gracefully. */
export function rootCrumbs(href: string): BreadcrumbItem[] {
  const item = NAV_ITEMS.find((candidate) => candidate.href === href);
  if (!item) throw new Error(`rootCrumbs: no NAV_ITEMS entry for "${href}"`);
  return [{ label: item.group }, { label: item.label, href: item.href }];
}
