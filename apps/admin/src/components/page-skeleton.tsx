import { Card, CardList, cn, LoadingRegion, Skeleton, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";

// Route-level loading states (each (shell) route's loading.tsx). They render inside AdminShell's
// content area only, so the sidebar, top bar and bottom nav stay mounted while a page loads.
// Every block mirrors the real component's box (Breadcrumb's mb-2 text-sm row, PageHeader's
// text-3xl title and pb-6, FilterTabs' min-h-11 pills, Input's h-11, TableContainer/CardList's
// md breakpoint) so nothing jumps when the data arrives.

// Varied widths so rows read as text, not as a grid of identical bars.
const WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-5/6", "w-2/5"] as const;
const width = (index: number) => WIDTHS[index % WIDTHS.length];

export function BreadcrumbSkeleton() {
  return (
    <div className="mb-2 flex h-5 items-center gap-1.5">
      <Skeleton className="h-4 w-16" />
      <Skeleton className="h-4 w-20" />
    </div>
  );
}

export function PageHeaderSkeleton({ description = true, action = false }: { description?: boolean; action?: boolean }) {
  return (
    <div className="flex flex-col gap-3 pb-6 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-1">
        <Skeleton className="h-9 w-44" />
        {description && <Skeleton className="h-6 w-72 max-w-full" />}
      </div>
      {action && <Skeleton className="h-11 w-36 shrink-0" />}
    </div>
  );
}

export function FilterTabsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="flex gap-2 overflow-hidden">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-11 w-24 shrink-0 rounded-full" />
      ))}
    </div>
  );
}

export function InputSkeleton({ className = "w-full" }: { className?: string }) {
  return <Skeleton className={cn("h-11", className)} />;
}

export function TilesSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-24 rounded-lg" />
      ))}
    </div>
  );
}

/** Table rows on tablet/desktop, cards on phones: the same `md` split as TableContainer/CardList. */
export function ListSkeleton({ columns = 5, rows = 8 }: { columns?: number; rows?: number }) {
  const columnIndexes = Array.from({ length: columns }, (_, index) => index);
  const rowIndexes = Array.from({ length: rows }, (_, index) => index);
  // The real list's markup (a table with headers, a list of cards) would read to assistive tech as
  // an empty table; LoadingRegion's status already says what is happening. `contents` keeps the
  // wrapper out of the layout.
  return (
    <div aria-hidden="true" className="contents">
      <CardList>
        {rowIndexes.slice(0, 5).map((row) => (
          <li key={row}>
            <Card className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className={`h-5 ${width(row)}`} />
                <Skeleton className={`h-4 ${width(row + 2)}`} />
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            </Card>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          {columnIndexes.map((column) => (
            <Th key={column}>
              <Skeleton className="h-4 w-20" />
            </Th>
          ))}
        </TableHead>
        <tbody>
          {rowIndexes.map((row) => (
            <Tr key={row}>
              {columnIndexes.map((column) => (
                <Td key={column}>
                  <Skeleton className={`h-5 ${width(row + column)}`} />
                </Td>
              ))}
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </div>
  );
}

export function PaginationSkeleton() {
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 pt-4">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-11 w-40" />
    </div>
  );
}

/** A bordered block of label/value rows (detail pages' info panels). */
export function SectionSkeleton({ lines = 4, heading = true }: { lines?: number; heading?: boolean }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4">
      {heading && <Skeleton className="h-6 w-40" />}
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="flex items-center justify-between gap-4">
          <Skeleton className="h-5 w-28" />
          <Skeleton className={`h-5 ${index % 2 ? "w-1/3" : "w-1/2"}`} />
        </div>
      ))}
    </div>
  );
}

/** Label + h-11 control pairs (Label + Input/Select). */
export function FormFieldsSkeleton({ fields = 5 }: { fields?: number }) {
  return (
    <div className="flex flex-col gap-5">
      {Array.from({ length: fields }, (_, index) => (
        <div key={index} className="flex flex-col gap-1.5">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-11 w-full" />
        </div>
      ))}
    </div>
  );
}

export interface ListPageSkeletonProps {
  /** Number of FilterTabs pills; 0 hides the row. */
  filters?: number;
  search?: boolean;
  /** Number of KPI tiles above the list; 0 hides them. */
  tiles?: number;
  columns?: number;
  rows?: number;
  action?: boolean;
  pagination?: boolean;
  description?: boolean;
}

/** List pages: breadcrumb, header, optional tiles/filters/search, table (desktop) or cards (phone). */
export function ListPageSkeleton({
  filters = 0,
  search = false,
  tiles = 0,
  columns = 5,
  rows = 8,
  action = false,
  pagination = true,
  description = true,
}: ListPageSkeletonProps) {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton description={description} action={action} />
      <div className="flex flex-col gap-3">
        {tiles > 0 && <TilesSkeleton count={tiles} />}
        {filters > 0 && <FilterTabsSkeleton count={filters} />}
        {search && <InputSkeleton />}
        <ListSkeleton columns={columns} rows={rows} />
      </div>
      {pagination && <PaginationSkeleton />}
    </LoadingRegion>
  );
}

export interface DetailPageSkeletonProps {
  /** Lines per info section, one section per entry. */
  sections?: readonly number[];
  /** A table of line items under the sections (order items, batch lines, movements). */
  table?: { columns: number; rows: number };
  action?: boolean;
  tiles?: number;
  /** Spacing between the blocks; pages whose sections sit flush (no wrapper gap) pass "gap-0". */
  gap?: "gap-0" | "gap-6";
}

/** Detail pages: breadcrumb, header, optional tiles, info sections, optional line-item list. */
export function DetailPageSkeleton({ sections = [5], table, action = false, tiles = 0, gap = "gap-6" }: DetailPageSkeletonProps) {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton action={action} />
      <div className={`flex flex-col ${gap}`}>
        {tiles > 0 && <TilesSkeleton count={tiles} />}
        {sections.map((lines, index) => (
          <SectionSkeleton key={index} lines={lines} />
        ))}
        {table && <ListSkeleton columns={table.columns} rows={table.rows} />}
      </div>
    </LoadingRegion>
  );
}

/** Create/edit form pages: breadcrumb, header, a form column of label + control pairs. */
export function FormPageSkeleton({ fields = 6, description = true }: { fields?: number; description?: boolean }) {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton description={description} />
      <div className="flex max-w-2xl flex-col gap-6">
        <FormFieldsSkeleton fields={fields} />
        <Skeleton className="h-11 w-32" />
      </div>
    </LoadingRegion>
  );
}
