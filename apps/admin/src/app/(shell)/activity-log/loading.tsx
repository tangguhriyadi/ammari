import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, ListSkeleton, PageHeaderSkeleton, PaginationSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton action />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex flex-col gap-1.5">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-11 w-full" />
          </div>
        ))}
        <Skeleton className="h-11 w-36" />
      </div>
      <ListSkeleton columns={4} />
      <PaginationSkeleton />
    </LoadingRegion>
  );
}
