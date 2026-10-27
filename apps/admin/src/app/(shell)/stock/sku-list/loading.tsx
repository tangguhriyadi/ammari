import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, FilterTabsSkeleton, InputSkeleton, ListSkeleton, PageHeaderSkeleton } from "@/components/page-skeleton";

// Status filter, search row, the count + copy buttons row, then the whole SKU list (no paging).
export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton action />
      <div className="flex flex-col gap-3">
        <FilterTabsSkeleton count={3} />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
          <InputSkeleton className="w-full sm:flex-1" />
          <Skeleton className="h-11 w-24" />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-11 w-64" />
        </div>
        <ListSkeleton columns={6} rows={12} />
      </div>
    </LoadingRegion>
  );
}
