import type { PermissionKey } from "@ammari/db/rbac";
import { MOBILE_PRIMARY_COUNT, type NavItem } from "./config";

/** Filters the full nav config down to what a session with `permissionKeys` may see. Purely
 * cosmetic — hiding an item never substitutes for `requirePermission`, which every page/action/
 * route handler calls independently (docs/SPEC.md §9). */
export function filterNavByPermissions(
  items: readonly NavItem[],
  permissionKeys: readonly PermissionKey[],
): NavItem[] {
  const granted = new Set(permissionKeys);
  return items.filter((item) => item.permissionKeys.some((key) => granted.has(key)));
}

/** The up-to-4 items shown in the mobile bottom nav: the designated primaries first (in catalog
 * order), padded from the rest of the permitted list when the session lacks one of them. */
export function getMobilePrimaryItems(filteredItems: readonly NavItem[]): NavItem[] {
  const primaries = filteredItems.filter((item) => item.mobilePrimary);
  if (primaries.length >= MOBILE_PRIMARY_COUNT) return primaries.slice(0, MOBILE_PRIMARY_COUNT);

  const primaryHrefs = new Set(primaries.map((item) => item.href));
  const fallback = filteredItems.filter((item) => !primaryHrefs.has(item.href));
  return [...primaries, ...fallback].slice(0, MOBILE_PRIMARY_COUNT);
}
