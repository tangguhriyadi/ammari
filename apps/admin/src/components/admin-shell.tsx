import type { ReactNode } from "react";
import { cookies } from "next/headers";
import type { StaffSessionData } from "@ammari/auth/staff";
import { NAV_ITEMS } from "@/lib/nav/config";
import { filterNavByPermissions, getMobilePrimaryItems } from "@/lib/nav/filter";
import { NavPendingProvider, type NavLinkItem } from "./nav-link";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { BottomNav } from "./bottom-nav";
import { AccountMenu } from "./account-menu";
import { SidebarState } from "./sidebar-state";
import { parseSidebarCollapsed, SIDEBAR_COOKIE_NAME } from "@/lib/nav/sidebar-preference";

// A Server Component: filtering the nav and rendering icon elements both run fine on the server,
// and keeping this out of the client bundle is what lets Sidebar/AccountMenu stay Server
// Components too (only NavLink, the interactive sheets, and their toggle buttons are client —
// see nav-link.tsx's doc comment).
export async function AdminShell({ session, children }: { session: StaffSessionData; children: ReactNode }) {
  const initialCollapsed = parseSidebarCollapsed((await cookies()).get(SIDEBAR_COOKIE_NAME)?.value);
  const navItems = filterNavByPermissions(NAV_ITEMS, session.permissionKeys);
  const mobilePrimaryItems = getMobilePrimaryItems(navItems);
  const mobilePrimaryHrefs = new Set(mobilePrimaryItems.map((item) => item.href));
  const remainingItems = navItems.filter((item) => !mobilePrimaryHrefs.has(item.href));

  const toNavLinkItem = (item: (typeof navItems)[number]): NavLinkItem => {
    const Icon = item.icon;
    return { href: item.href, label: item.label, icon: <Icon aria-hidden="true" className="size-5" /> };
  };

  return (
    <SidebarState initialCollapsed={initialCollapsed}>
      <NavPendingProvider>
        <Sidebar items={navItems} session={session} />
        <Topbar accountMenu={<AccountMenu session={session} />} />
        <main className="pt-[calc(3.5rem+env(safe-area-inset-top))] pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pt-0 lg:pb-0 lg:pl-[272px] lg:transition-[padding-left] lg:duration-200 motion-reduce:transition-none lg:group-data-[collapsed=true]/shell:pl-[72px]">
          <div className="w-full px-4 py-6 lg:px-8">{children}</div>
        </main>
        <BottomNav
          primaryItems={mobilePrimaryItems.map(toNavLinkItem)}
          remainingItems={remainingItems.map(toNavLinkItem)}
        />
      </NavPendingProvider>
    </SidebarState>
  );
}
