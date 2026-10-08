import Link from "next/link";

export interface BreadcrumbItem {
  label: string;
  /** Omit on the last item — it's the current page, rendered as plain text, not a link. */
  href?: string;
}

export interface BreadcrumbProps {
  items: readonly BreadcrumbItem[];
}

/** Same position on every page in the shell — rendered first, above `PageHeader`. Every item
 * (including the current, non-link one) truncates rather than wraps, so a long entity name on a
 * narrow phone screen never forces horizontal scroll. */
export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav aria-label="Navigasi breadcrumb" className="mb-2 min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm text-neutral-600">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
              {index > 0 && <span aria-hidden="true" className="shrink-0 text-neutral-400">/</span>}
              {isLast || !item.href ? (
                <span
                  className="min-w-0 truncate font-medium text-neutral-900"
                  aria-current={isLast ? "page" : undefined}
                >
                  {item.label}
                </span>
              ) : (
                <Link href={item.href} className="min-w-0 truncate hover:text-neutral-900 hover:underline">
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
