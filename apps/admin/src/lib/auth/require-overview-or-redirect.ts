import "server-only";
import { forbidden, redirect } from "next/navigation";
import type { StaffSessionData } from "@ammari/auth/staff";
import { NAV_ITEMS } from "@/lib/nav/config";
import { firstAllowedHref } from "@/lib/nav/filter";
import { getStaffSession } from "./staff-session";

/** `/` (Ringkasan) only. Same contract as `requirePermission("overview.view")`, except that a
 * session without overview.view is redirected to the first page it may open instead of a 403:
 * both login methods land on `/`, so a role like Packing/Gudang would otherwise see "Akses
 * ditolak" right after logging in (docs/plans/roles-staff.md §5). The 403 stays for a session
 * that may open nothing at all. */
export async function requireOverviewOrRedirect(): Promise<StaffSessionData> {
  const session = await getStaffSession();
  if (!session) redirect("/login");
  if (session.permissionKeys.includes("overview.view")) return session;
  const href = firstAllowedHref(NAV_ITEMS, session.permissionKeys);
  if (href && href !== "/") redirect(href);
  forbidden();
}
