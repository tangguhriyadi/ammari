import { NAV_ITEMS } from "./config";

/** Segment-prefix match: `/products` is active for `/products`, `/products/new`, `/products/[id]`, etc.
 * `/` (Ringkasan) is the one exception — it must match ONLY the home page, never every route. */
function matchesPrefix(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Of every item whose href prefix-matches `pathname`, the one with the longest href — e.g. on
 * `/content/size-charts/new`, both `/content` and `/content/size-charts` prefix-match, but
 * `/content/size-charts` wins so only "Tabel Ukuran" highlights, not "Beranda" too. */
function longestMatchingHref(pathname: string, items: readonly { href: string }[]): string | null {
  let best: string | null = null;
  for (const item of items) {
    if (matchesPrefix(pathname, item.href) && (best === null || item.href.length > best.length)) {
      best = item.href;
    }
  }
  return best;
}

/** Whether `href` should render as active for `pathname`, given the full set of nav items it's
 * competing against (defaults to the real sidebar/bottom-nav menu). A prefix match alone isn't
 * enough — `href` must also be the *longest* matching item, so exactly one item is ever active. */
export function isNavItemActive(
  pathname: string,
  href: string,
  items: readonly { href: string }[] = NAV_ITEMS,
): boolean {
  if (!matchesPrefix(pathname, href)) return false;
  return href === longestMatchingHref(pathname, items);
}
