import Link from "next/link";
import type { Pagination as PaginationData } from "../lib/pagination";
import { cn } from "../lib/cn";
import { PerPageSelect } from "./PerPageSelect";

export interface PaginationProps {
  pagination: PaginationData;
  /** The route this list lives on, e.g. "/products". */
  basePath: string;
  /** Other query params to preserve across page/perPage links (e.g. { q: "gamis" }). */
  searchParams?: Record<string, string | undefined>;
  /** Plural label for the count line, e.g. "produk" -> "42 produk". */
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
 * screens; phones get just Prev/Next + "Halaman X dari Y" to stay single-column. The page-size
 * control is the one interactive (client) piece — see PerPageSelect. */
export function Pagination({ pagination, basePath, searchParams = {}, itemLabel }: PaginationProps) {
  const { page, pageSize, totalPages, totalCount } = pagination;
  const from = totalCount === 0 ? 0 : pagination.offset + 1;
  const to = Math.min(pagination.offset + pageSize, totalCount);

  if (totalPages <= 1 && totalCount === 0) {
    return (
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 pt-4">
        <p className="text-sm text-neutral-600">0 {itemLabel}</p>
        <PerPageSelect basePath={basePath} searchParams={searchParams} value={pageSize} />
      </div>
    );
  }

  const nearbyStart = Math.max(1, page - 2);
  const nearbyEnd = Math.min(totalPages, page + 2);
  const nearbyPages = Array.from({ length: nearbyEnd - nearbyStart + 1 }, (_, i) => nearbyStart + i);

  return (
    <div className="mt-6 flex flex-col gap-3 border-t border-neutral-200 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-neutral-600">
          Menampilkan {from}–{to} dari {totalCount} {itemLabel}
        </p>
        <PerPageSelect basePath={basePath} searchParams={searchParams} value={pageSize} />
      </div>
      <nav aria-label="Navigasi halaman" className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-neutral-600">
          Halaman {page} dari {totalPages}
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
    </div>
  );
}
