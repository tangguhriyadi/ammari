import { Tabs } from "./Tabs";

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
 * a filtered view stays bookmarkable and survives a reload. Renders through the shared `Tabs`
 * presentation — see its doc comment for why these are plain links, not the ARIA tabs pattern. */
export function FilterTabs({ basePath, paramName, options, activeValue, ...rest }: FilterTabsProps) {
  const items = options.map((option) => ({
    label: option.label,
    href: option.value ? `${basePath}?${paramName}=${option.value}` : basePath,
    isActive: option.value === activeValue,
  }));
  return <Tabs items={items} aria-label={rest["aria-label"]} />;
}
