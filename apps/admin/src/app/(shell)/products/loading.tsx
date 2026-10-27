import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, ListSkeleton, PageHeaderSkeleton, PaginationSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton action />
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_14rem_auto] sm:items-end">
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-11 w-full" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-11 w-full" />
          </div>
          <Skeleton className="h-11 w-28" />
        </div>
        <ListSkeleton columns={9} />
      </div>
      <PaginationSkeleton />
    </LoadingRegion>
  );
}
