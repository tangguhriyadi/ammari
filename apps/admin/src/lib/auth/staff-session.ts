import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { loadStaffSessionData, type StaffSessionData } from "@ammari/auth/staff";
import { db } from "@ammari/db";
import { staffAuth } from "./staff";

/** Never trusts the Better Auth session payload alone — re-derives role/permissions/is_active
 * from `staff_users` on every call, so a staff member deactivated mid-session loses access on
 * their very next request, not just their next login (docs/SPEC.md §10). Memoized per request
 * via React's `cache()`, same pattern Next's own DAL guide recommends. */
export const getStaffSession = cache(async (): Promise<StaffSessionData | null> => {
  const session = await staffAuth.api.getSession({ headers: await headers() });
  const staffAuthUserId = session?.user?.id;
  if (!staffAuthUserId) return null;

  const staffUserId = (session.user as { staffUserId?: string }).staffUserId;
  if (!staffUserId) return null;

  return loadStaffSessionData(db, staffUserId);
});
