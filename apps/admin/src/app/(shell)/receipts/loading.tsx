import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, ListSkeleton, PageHeaderSkeleton, PaginationSkeleton } from "@/components/page-skeleton";

// The filter grid (source, supplier, two dates, status, apply button), then the receipt list.
export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
        {[0, 1, 2, 3, 4].map((field) => (
          <div key={field} className="flex flex-col gap-1.5">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-11 w-full" />
          </div>
        ))}
        <Skeleton className="h-11 w-28" />
      </div>
      <ListSkeleton columns={7} />
      <PaginationSkeleton />
    </LoadingRegion>
  );
}
