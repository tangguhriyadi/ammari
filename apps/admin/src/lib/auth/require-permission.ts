import "server-only";
import { redirect } from "next/navigation";
import { forbidden } from "next/navigation";
import type { PermissionKey } from "@ammari/db/rbac";
import { getStaffSession } from "./staff-session";
import type { StaffSessionData } from "@ammari/auth/staff";

/** Every admin page, server action, and route handler must call this — proxy.ts only does a
 * coarse "is there any valid staff session" check (see docs/SPEC.md §10); it is never the sole
 * authorization boundary (per Next's own data-security guidance: Server Functions are not
 * separate routes in proxy's matcher chain). Redirects to /login when unauthenticated; renders
 * the 403 page when authenticated but missing the permission. */
export async function requirePermission(permissionKey: PermissionKey): Promise<StaffSessionData> {
  const session = await getStaffSession();
  if (!session) redirect("/login");
  if (!session.permissionKeys.includes(permissionKey)) forbidden();
  return session;
}

/** Same as `requirePermission`, but passes if the session holds ANY of the given keys — for an
 * action reached from more than one permission-gated surface (e.g. revalidateProductAction,
 * called after both a `products.manage`-gated save and a `content.manage`-gated one). Prefer
 * `requirePermission` for anything gated by exactly one permission; this is for the rare action
 * that genuinely serves two different gates at once. */
export async function requireAnyPermission(permissionKeys: readonly PermissionKey[]): Promise<StaffSessionData> {
  const session = await getStaffSession();
  if (!session) redirect("/login");
  if (!permissionKeys.some((key) => session.permissionKeys.includes(key))) forbidden();
  return session;
}
