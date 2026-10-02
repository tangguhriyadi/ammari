import Link from "next/link";
import type { Pagination as PaginationData } from "../lib/pagination";
import { cn } from "../lib/cn";

export interface PaginationProps {
  pagination: PaginationData;
  /** The route this list lives on, e.g. "/produk". */
  basePath: string;
  /** Other query params to preserve across page links (e.g. { q: "gamis" }). */
  searchParams?: Record<string, string | undefined>;
  /** Plural label for the total-count line, e.g. "produk" -> "42 produk". */
  itemLabel: string;
}

function hrefForPage(basePath: string, searchParams: Record<string, string | undefined>, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value) params.set(key, value);
  }
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

/** Plain `<a>`/`<Link>` navigation — works without JS. Shows the current page ±2 on larger
 * screens; phones get just Prev/Next + "Halaman X dari Y" to stay single-column. */
export function Pagination({ pagination, basePath, searchParams = {}, itemLabel }: PaginationProps) {
  const { page, totalPages, totalCount } = pagination;
  if (totalPages <= 1 && totalCount === 0) {
    return <p className="text-sm text-neutral-600">0 {itemLabel}</p>;
  }

  const nearbyStart = Math.max(1, page - 2);
  const nearbyEnd = Math.min(totalPages, page + 2);
  const nearbyPages = Array.from({ length: nearbyEnd - nearbyStart + 1 }, (_, i) => nearbyStart + i);

  return (
    <nav
      aria-label="Navigasi halaman"
      className="mt-6 flex flex-col items-center gap-3 border-t border-neutral-200 pt-4 sm:flex-row sm:justify-between"
    >
      <p className="text-sm text-neutral-600">
        {totalCount} {itemLabel} · Halaman {page} dari {totalPages}
      </p>
      <div className="flex items-center gap-1">
        {page > 1 ? (
          <Link
            href={hrefForPage(basePath, searchParams, page - 1)}
            className="flex min-h-11 items-center rounded-md px-3 text-base font-medium text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Sebelumnya
          </Link>
        ) : (
          <span className="flex min-h-11 items-center px-3 text-base font-medium text-neutral-400" aria-disabled="true">
            Sebelumnya
          </span>
        )}

        <div className="hidden items-center gap-1 sm:flex">
          {nearbyPages.map((candidate) => (
            <Link
              key={candidate}
              href={hrefForPage(basePath, searchParams, candidate)}
              aria-current={candidate === page ? "page" : undefined}
              className={cn(
                "flex size-11 items-center justify-center rounded-md text-base font-medium",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                candidate === page ? "bg-neutral-100 text-brand" : "text-neutral-700 hover:bg-neutral-100",
              )}
            >
              {candidate}
            </Link>
          ))}
        </div>

        {page < totalPages ? (
          <Link
            href={hrefForPage(basePath, searchParams, page + 1)}
            className="flex min-h-11 items-center rounded-md px-3 text-base font-medium text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Berikutnya
          </Link>
        ) : (
          <span className="flex min-h-11 items-center px-3 text-base font-medium text-neutral-400" aria-disabled="true">
            Berikutnya
          </span>
        )}
      </div>
    </nav>
  );
}
