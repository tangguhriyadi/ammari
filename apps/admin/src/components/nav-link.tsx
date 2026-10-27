"use client";

import { type MouseEvent, type ReactNode, createContext, useContext, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@ammari/ui";
import { isNavItemActive } from "@/lib/nav/is-active";
import { isPlainLeftClick, type NavPendingState, resolveNavPath, syncNavPending } from "@/lib/nav/pending-nav";

export interface NavLinkItem {
  href: string;
  label: string;
  icon: ReactNode;
}

const NavPendingContext = createContext<{ navPath: string; startNav: (href: string) => void } | null>(null);

/** Shared by the sidebar, bottom nav and "Lainnya" sheet so a click highlights its item at once,
 * in every nav, while the new page is still loading (each route's loading.tsx fills the content
 * area). Any pathname change ends the pending click (syncNavPending). */
export function NavPendingProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [state, setState] = useState<NavPendingState>({ pathname, pending: null });
  // Adjusting state during render (React's documented alternative to an effect): a pathname
  // change ends the pending click before this render's output is used.
  const synced = syncNavPending(state, pathname);
  if (synced !== state) setState(synced);
  const navPath = resolveNavPath(pathname, synced.pending);
  const startNav = (href: string) => setState({ pathname, pending: href === pathname ? null : { href, from: pathname } });
  return <NavPendingContext value={{ navPath, startNav }}>{children}</NavPendingContext>;
}

/** Intent-only prefetch: `prefetch={false}` until the pointer or keyboard focus reaches the link,
 * then the default (`null`: the route down to its loading.tsx). Viewport prefetch would fire one
 * request per visible nav item on every page load, each running proxy.ts's database-backed session
 * check (docs/plans/admin-performance.md). */
function useNavLinkBehavior(href: string, onClick?: () => void) {
  const context = useContext(NavPendingContext);
  if (!context) throw new Error("NavLink must be used inside <NavPendingProvider>");
  const [intent, setIntent] = useState(false);
  const showIntent = () => setIntent(true);
  return {
    active: isNavItemActive(context.navPath, href),
    linkProps: {
      prefetch: intent ? null : false,
      onPointerEnter: showIntent,
      onTouchStart: showIntent,
      onFocus: showIntent,
      onClick: (event: MouseEvent<HTMLAnchorElement>) => {
        if (isPlainLeftClick(event)) context.startNav(href);
        onClick?.();
      },
    },
  };
}

/** The only piece of the nav that genuinely needs to be a Client Component: active-link
 * highlighting depends on the current path, which Next's nested layouts don't re-derive on a
 * client-side navigation. Everything around it (Sidebar, AccountMenu, the shell itself) stays a
 * Server Component and composes this as a leaf, so the icon set and static nav markup don't ship
 * to the client bundle for no reason. */
export function NavLink({
  href,
  icon,
  label,
  variant = "sidebar",
  onClick,
}: NavLinkItem & { variant?: "sidebar" | "bottom" | "rail"; onClick?: () => void }) {
  const { active, linkProps } = useNavLinkBehavior(href, onClick);

  if (variant === "bottom") {
    return (
      <Link
        href={href}
        {...linkProps}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset",
          active ? "text-brand" : "text-neutral-600",
        )}
      >
        {icon}
        {label}
      </Link>
    );
  }

  if (variant === "rail") {
    return <SidebarLink href={href} icon={icon} label={label} active={active} linkProps={linkProps} />;
  }

  return (
    <Link
      href={href}
      {...linkProps}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-md px-3 text-base font-medium",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
        active ? "bg-neutral-100 text-brand" : "text-neutral-700 hover:bg-neutral-50",
      )}
    >
      {icon}
      {label}
    </Link>
  );
}

/** Desktop sidebar row (`variant="rail"`; the phone sheet keeps the plain `sidebar` variant). When the sidebar is collapsed (`data-collapsed` on the shell wrapper) the
 * label stays in the DOM as screen-reader text, and a fixed-position tooltip shows it on hover and
 * keyboard focus. Fixed, not absolute, so the nav's own scroll container can't clip it. */
function SidebarLink({
  href,
  icon,
  label,
  active,
  linkProps,
}: NavLinkItem & { active: boolean; linkProps: ReturnType<typeof useNavLinkBehavior>["linkProps"] }) {
  const [tip, setTip] = useState<{ top: number; left: number } | null>(null);

  const showTip = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setTip({ top: rect.top + rect.height / 2, left: rect.right + 8 });
  };

  return (
    <>
      <Link
        href={href}
        {...linkProps}
        aria-current={active ? "page" : undefined}
        onMouseEnter={(event) => showTip(event.currentTarget)}
        onMouseLeave={() => setTip(null)}
        onFocus={(event) => {
          linkProps.onFocus();
          if (event.currentTarget.matches(":focus-visible")) showTip(event.currentTarget);
        }}
        onBlur={() => setTip(null)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setTip(null);
        }}
        className={cn(
          "flex min-h-11 items-center gap-3 rounded-md px-3 text-base font-medium",
          "group-data-[collapsed=true]/shell:justify-center group-data-[collapsed=true]/shell:px-0",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
          active
            ? "bg-neutral-100 text-brand group-data-[collapsed=true]/shell:bg-brand group-data-[collapsed=true]/shell:text-brand-foreground"
            : "text-neutral-700 hover:bg-neutral-50",
        )}
      >
        {icon}
        <span className="truncate group-data-[collapsed=true]/shell:sr-only">{label}</span>
      </Link>
      {tip && (
        <span
          aria-hidden="true"
          data-testid="sidebar-tooltip"
          style={{ top: tip.top, left: tip.left }}
          className="pointer-events-none fixed z-50 hidden -translate-y-1/2 rounded-md bg-neutral-900 px-2.5 py-1.5 text-sm font-medium whitespace-nowrap text-white shadow-sm group-data-[collapsed=true]/shell:block"
        >
          {label}
        </span>
      )}
    </>
  );
}
