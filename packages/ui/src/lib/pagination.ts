export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
export type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_PAGE_SIZE: PageSizeOption = 20;

function isPageSizeOption(value: number): value is PageSizeOption {
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(value);
}

export interface ResolvePaginationInput {
  /** Raw `?page=` value — may be missing, non-numeric, fractional, zero, negative, or beyond
   * the last page. Always clamps to something safe; never throws. */
  rawPage: string | number | undefined;
  /** Raw `?perPage=` value — validated against PAGE_SIZE_OPTIONS; anything else (missing,
   * non-numeric, or outside the whitelist) falls back to `pageSize` (or DEFAULT_PAGE_SIZE). */
  rawPerPage?: string | number | undefined;
  totalCount: number;
  /** Fallback used when `rawPerPage` is absent or invalid. Defaults to DEFAULT_PAGE_SIZE. */
  pageSize?: number;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalPages: number;
  /** 1 when totalCount is 0 — "page 1 of 1", not "of 0". */
  totalCount: number;
  offset: number;
  limit: number;
}

/** Turns untrusted `?page=`/`?perPage=` query params into a safe, clamped pagination descriptor
 * — a bad value (text, 0, negative, decimal, far beyond the last page, a page size outside the
 * whitelist) always resolves to something safe, never a 500 from an invalid LIMIT/OFFSET. */
export function resolvePagination({ rawPage, rawPerPage, totalCount, pageSize }: ResolvePaginationInput): Pagination {
  const parsedPerPage = typeof rawPerPage === "number" ? rawPerPage : Number.parseInt(String(rawPerPage ?? ""), 10);
  const resolvedPageSize = isPageSizeOption(parsedPerPage) ? parsedPerPage : pageSize ?? DEFAULT_PAGE_SIZE;

  const totalPages = Math.max(1, Math.ceil(totalCount / resolvedPageSize));

  const parsed = typeof rawPage === "number" ? rawPage : Number.parseInt(String(rawPage ?? ""), 10);
  const page = Number.isFinite(parsed) ? Math.min(Math.max(1, Math.trunc(parsed)), totalPages) : 1;

  return {
    page,
    pageSize: resolvedPageSize,
    totalPages,
    totalCount,
    offset: (page - 1) * resolvedPageSize,
    limit: resolvedPageSize,
  };
}
