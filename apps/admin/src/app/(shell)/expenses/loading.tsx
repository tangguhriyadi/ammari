import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, FilterTabsSkeleton, ListSkeleton, PageHeaderSkeleton, PaginationSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton action />
      {/* "Arus kas keluar": heading and four tiles. */}
      <div className="mb-6 flex flex-col gap-3 rounded-lg border border-neutral-200 p-4">
        <Skeleton className="h-6 w-56" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      </div>
      <div className="mb-6 border-b border-neutral-200 pb-4">
        <FilterTabsSkeleton count={3} />
      </div>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1.5">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-11 w-full" />
            </div>
          ))}
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-36" />
        </div>
        <Skeleton className="h-6 w-56" />
        <ListSkeleton columns={10} />
      </div>
      <PaginationSkeleton />
    </LoadingRegion>
  );
}
