import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

/** Title uses the serif wordmark font — reserved for the wordmark and page titles at 24px+ per
 * the typography rule (thin serifs are hard to read smaller, and the admin is used mostly on a
 * phone). Everything else here is Inter. */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 pb-6 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-1">
        <h1 className="text-balance font-serif text-3xl font-light text-neutral-900">{title}</h1>
        {description && <p className="text-pretty text-base text-neutral-600">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
