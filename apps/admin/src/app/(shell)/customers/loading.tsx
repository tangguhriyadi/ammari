import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, FilterTabsSkeleton, ListSkeleton, PageHeaderSkeleton, PaginationSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton action />
      <div className="mb-6 border-b border-neutral-200 pb-4">
        <FilterTabsSkeleton count={2} />
      </div>
      <div className="flex flex-col gap-3">
        <FilterTabsSkeleton count={5} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1.5">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-11 w-full" />
            </div>
          ))}
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-36" />
        </div>
        <Skeleton className="h-5 w-96 max-w-full" />
        <ListSkeleton columns={8} />
      </div>
      <PaginationSkeleton />
    </LoadingRegion>
  );
}
