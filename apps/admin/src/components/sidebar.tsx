import type { StaffSessionData } from "@ammari/auth/staff";
import type { NavItem } from "@/lib/nav/config";
import { NavLink } from "./nav-link";
import { AccountMenu } from "./account-menu";

function groupItems(items: readonly NavItem[]): [string, NavItem[]][] {
  const groups = new Map<string, NavItem[]>();
  for (const item of items) {
    const group = groups.get(item.group) ?? [];
    group.push(item);
    groups.set(item.group, group);
  }
  return [...groups.entries()];
}

export function Sidebar({ items, session }: { items: readonly NavItem[]; session: StaffSessionData }) {
  return (
    <aside className="fixed inset-y-0 left-0 hidden w-[272px] flex-col border-r border-neutral-200 bg-white lg:flex">
      <div className="flex h-16 items-center px-6">
        <span className="font-serif text-2xl font-light tracking-[0.2em] text-brand">AMMARI</span>
      </div>
      <nav aria-label="Navigasi utama" className="flex-1 overflow-y-auto px-3 py-2">
        {groupItems(items).map(([group, groupItems]) => (
          <div key={group} className="mb-4">
            <p className="px-3 pb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">{group}</p>
            <ul className="flex flex-col gap-0.5">
              {groupItems.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <NavLink
                      href={item.href}
                      label={item.label}
                      icon={<Icon aria-hidden="true" className="size-5 shrink-0" />}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t border-neutral-200 p-4">
        <AccountMenu session={session} />
      </div>
    </aside>
  );
}
