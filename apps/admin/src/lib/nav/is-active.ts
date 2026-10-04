/** Segment-prefix match: `/products` is active for `/products`, `/products/new`, `/products/[id]`, etc.
 * `/` (Ringkasan) is the one exception — it must match ONLY the home page, never every route. */
export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
