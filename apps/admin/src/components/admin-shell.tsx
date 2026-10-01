import type { ReactNode } from "react";
import type { StaffSessionData } from "@ammari/auth/staff";
import { NAV_ITEMS } from "@/lib/nav/config";
import { filterNavByPermissions, getMobilePrimaryItems } from "@/lib/nav/filter";
import type { NavLinkItem } from "./nav-link";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { BottomNav } from "./bottom-nav";
import { AccountMenu } from "./account-menu";

// A Server Component: filtering the nav and rendering icon elements both run fine on the server,
// and keeping this out of the client bundle is what lets Sidebar/AccountMenu stay Server
// Components too (only NavLink, the interactive sheets, and their toggle buttons are client —
// see nav-link.tsx's doc comment).
export function AdminShell({ session, children }: { session: StaffSessionData; children: ReactNode }) {
  const navItems = filterNavByPermissions(NAV_ITEMS, session.permissionKeys);
  const mobilePrimaryItems = getMobilePrimaryItems(navItems);
  const mobilePrimaryHrefs = new Set(mobilePrimaryItems.map((item) => item.href));
  const remainingItems = navItems.filter((item) => !mobilePrimaryHrefs.has(item.href));

  const toNavLinkItem = (item: (typeof navItems)[number]): NavLinkItem => {
    const Icon = item.icon;
    return { href: item.href, label: item.label, icon: <Icon aria-hidden="true" className="size-5" /> };
  };

  return (
    <div className="min-h-screen bg-neutral-50">
      <Sidebar items={navItems} session={session} />
      <Topbar accountMenu={<AccountMenu session={session} />} />
      <main className="pt-[calc(3.5rem+env(safe-area-inset-top))] pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pt-0 lg:pb-0 lg:pl-[272px]">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 lg:px-8">{children}</div>
      </main>
      <BottomNav
        primaryItems={mobilePrimaryItems.map(toNavLinkItem)}
        remainingItems={remainingItems.map(toNavLinkItem)}
      />
    </div>
  );
}
