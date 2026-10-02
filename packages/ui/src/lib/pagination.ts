export interface ResolvePaginationInput {
  /** Raw `?page=` value — may be missing, non-numeric, fractional, zero, negative, or beyond
   * the last page. Always clamps to something safe; never throws. */
  rawPage: string | number | undefined;
  totalCount: number;
  pageSize: number;
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

/** Turns an untrusted `?page=` query param into a safe, clamped pagination descriptor — a bad
 * value (text, 0, negative, decimal, far beyond the last page) always resolves to page 1 or the
 * last real page, never a 500 from an invalid LIMIT/OFFSET. */
export function resolvePagination({ rawPage, totalCount, pageSize }: ResolvePaginationInput): Pagination {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const parsed = typeof rawPage === "number" ? rawPage : Number.parseInt(String(rawPage ?? ""), 10);
  const page = Number.isFinite(parsed) ? Math.min(Math.max(1, Math.trunc(parsed)), totalPages) : 1;

  return {
    page,
    pageSize,
    totalPages,
    totalCount,
    offset: (page - 1) * pageSize,
    limit: pageSize,
  };
}
