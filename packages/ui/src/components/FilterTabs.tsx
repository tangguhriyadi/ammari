import Link from "next/link";
import { cn } from "../lib/cn";

export interface FilterTabOption {
  label: string;
  /** `undefined` = "show all", omits the query param entirely rather than sending an empty
   * value. */
  value?: string;
}

export interface FilterTabsProps {
  /** The route this filter lives on, e.g. "/production". */
  basePath: string;
  paramName: string;
  options: readonly FilterTabOption[];
  activeValue: string | undefined;
  "aria-label": string;
}

/** URL-driven filter tabs (the active filter is a `?paramName=` query param, not component
 * state) — same convention every other list page's filter/search/pagination already follows, so
 * a filtered view stays bookmarkable and survives a reload.
 *
 * Deliberately NOT the ARIA tabs pattern (`role="tablist"`/`"tab"`) — these are plain navigation
 * links that trigger a full page navigation, not an in-page panel switcher with roving-tabindex
 * and arrow-key handling, so applying that pattern without implementing its full keyboard
 * contract would misrepresent the control to assistive tech. `aria-current="true"` is the
 * correct, standard way to mark "this link represents the current view" on a navigation link. */
export function FilterTabs({ basePath, paramName, options, activeValue, ...rest }: FilterTabsProps) {
  return (
    <nav aria-label={rest["aria-label"]} className="mb-4 flex gap-2 overflow-x-auto">
      {options.map((option) => {
        const isActive = option.value === activeValue;
        const href = option.value ? `${basePath}?${paramName}=${option.value}` : basePath;
        return (
          <Link
            key={option.label}
            href={href}
            aria-current={isActive ? "true" : undefined}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-base font-medium transition-colors",
              isActive ? "bg-brand text-brand-foreground" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200",
            )}
          >
            {option.label}
          </Link>
        );
      })}
    </nav>
  );
}
