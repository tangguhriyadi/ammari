import "server-only";
import { redirect } from "next/navigation";
import { forbidden } from "next/navigation";
import type { PermissionKey } from "@ammari/db/rbac";
import { getStaffSession } from "./staff-session";
import type { StaffSessionData } from "@ammari/auth/staff";

/** Same contract as requirePermission/requireAnyPermission, but for an action gated by MORE THAN
 * ONE permission where EVERY key is required (e.g. posting a production batch needs both
 * production.manage and finance.view_profit — editing a draft's quantities needs only the
 * former). */
export async function requireAllPermissions(permissionKeys: readonly PermissionKey[]): Promise<StaffSessionData> {
  const session = await getStaffSession();
  if (!session) redirect("/login");
  if (!permissionKeys.every((key) => session.permissionKeys.includes(key))) forbidden();
  return session;
}
