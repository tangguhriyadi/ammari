"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@ammari/ui";
import { isNavItemActive } from "@/lib/nav/is-active";

export interface NavLinkItem {
  href: string;
  label: string;
  icon: ReactNode;
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
}: NavLinkItem & { variant?: "sidebar" | "bottom"; onClick?: () => void }) {
  const pathname = usePathname();
  const active = isNavItemActive(pathname, href);

  if (variant === "bottom") {
    return (
      <Link
        href={href}
        onClick={onClick}
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

  return (
    <Link
      href={href}
      onClick={onClick}
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
