import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getStaffSession } from "@/lib/auth/staff-session";
import { AdminShell } from "@/components/admin-shell";

// proxy.ts already redirects any unauthenticated request before it reaches this layout; this
// redirect is defensive only (e.g. a session that expires between proxy's check and render).
//
// Nav filtering happens inside AdminShell (a Client Component), not here: NAV_ITEMS carries
// lucide-react icon COMPONENTS, and a component reference can't cross the Server->Client prop
// boundary (only `session`, plain serializable data, is passed down). This discloses nothing
// extra — the full nav config ships to the client bundle either way, since Sidebar/BottomNav
// need the icons and active-path highlighting regardless of where the permission filter runs.
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const session = await getStaffSession();
  if (!session) redirect("/login");

  return <AdminShell session={session}>{children}</AdminShell>;
}
