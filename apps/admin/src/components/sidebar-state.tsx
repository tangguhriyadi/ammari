"use client";

import { type ReactNode, createContext, useCallback, useContext, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@ammari/ui";
import { writeSidebarPreference } from "@/lib/nav/sidebar-preference";

const SidebarCollapsedContext = createContext<{ collapsed: boolean; toggle: () => void } | null>(null);

/** Owns the desktop sidebar's collapsed state. The initial value comes from the cookie read on the
 * server, so the first render is already correct. The state is exposed to the (Server Component)
 * sidebar and content area purely as a `data-collapsed` attribute on the wrapper: they style
 * themselves with `group-data-[collapsed=true]/shell:` variants, so none of them has to become a
 * Client Component. Phone navigation never reads it. */
export function SidebarState({ initialCollapsed, children }: { initialCollapsed: boolean; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      writeSidebarPreference(next, document);
      return next;
    });
  }, []);

  return (
    <SidebarCollapsedContext value={{ collapsed, toggle }}>
      <div className="group/shell min-h-screen bg-neutral-50" data-collapsed={collapsed}>
        {children}
      </div>
    </SidebarCollapsedContext>
  );
}

export function useSidebarCollapsed() {
  const context = useContext(SidebarCollapsedContext);
  if (!context) throw new Error("useSidebarCollapsed must be used inside <SidebarState>");
  return context;
}

export function SidebarToggle({ className }: { className?: string }) {
  const { collapsed, toggle } = useSidebarCollapsed();
  const label = collapsed ? "Lebarkan menu" : "Ciutkan menu";
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls="admin-sidebar"
      onClick={toggle}
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-md text-neutral-700 hover:bg-neutral-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-5" />
    </button>
  );
}
