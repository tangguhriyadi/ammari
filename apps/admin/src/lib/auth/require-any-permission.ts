import "server-only";
import { redirect } from "next/navigation";
import { forbidden } from "next/navigation";
import type { PermissionKey } from "@ammari/db/rbac";
import { getStaffSession } from "./staff-session";
import type { StaffSessionData } from "@ammari/auth/staff";

/** Same contract as requirePermission, but for pages gated by more than one permission key where
 * holding any one of them is enough (e.g. Peran & Staf: staff.manage OR roles.manage). */
export async function requireAnyPermission(
  permissionKeys: readonly PermissionKey[],
): Promise<StaffSessionData> {
  const session = await getStaffSession();
  if (!session) redirect("/login");
  if (!permissionKeys.some((key) => session.permissionKeys.includes(key))) forbidden();
  return session;
}
