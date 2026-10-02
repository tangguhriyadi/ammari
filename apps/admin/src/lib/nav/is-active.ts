/** Segment-prefix match: `/produk` is active for `/produk`, `/produk/baru`, `/produk/[id]`, etc.
 * `/` (Ringkasan) is the one exception — it must match ONLY the home page, never every route. */
export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
