import Link from "next/link";
import { cn } from "../lib/cn";

export interface TabItem {
  label: string;
  href: string;
  isActive: boolean;
}

export interface TabsProps {
  items: readonly TabItem[];
  "aria-label": string;
}

/** The one shared compact tab/segmented control every list page uses — rounded pills, same
 * position relative to search/table everywhere. Deliberately NOT the ARIA tabs pattern
 * (`role="tablist"`/`"tab"`) — these are plain navigation links that trigger a full page
 * navigation (either a query-param filter via `FilterTabs`, or a different route entirely via
 * the admin app's route-level tabs), not an in-page panel switcher with roving-tabindex and
 * arrow-key handling. `aria-current="true"` is the correct, standard way to mark "this link
 * represents the current view" on a navigation link. */
export function Tabs({ items, ...rest }: TabsProps) {
  return (
    <nav aria-label={rest["aria-label"]} className="flex gap-2 overflow-x-auto">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.isActive ? "true" : undefined}
          className={cn(
            "inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-base font-medium transition-colors",
            item.isActive ? "bg-brand text-brand-foreground" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
