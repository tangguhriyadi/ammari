import { Card, LoadingRegion, Skeleton } from "@ammari/ui";
import {
  BreadcrumbSkeleton,
  FilterTabsSkeleton,
  InputSkeleton,
  PageHeaderSkeleton,
  PaginationSkeleton,
} from "@/components/page-skeleton";

// Stock type tabs, status filter, search row, then SKUs grouped per product (cards at every width).
export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton action />
      <div className="flex flex-col gap-3">
        <FilterTabsSkeleton count={4} />
        <FilterTabsSkeleton count={3} />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
          <InputSkeleton className="w-full sm:flex-1" />
          <Skeleton className="h-11 w-44" />
          <Skeleton className="h-11 w-24" />
        </div>
        <div className="flex flex-col gap-4">
          {[0, 1, 2].map((group) => (
            <Card key={group} className="flex flex-col gap-3">
              <Skeleton className="h-6 w-48" />
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-center justify-between gap-3">
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Skeleton className="h-5 w-1/2" />
                    <Skeleton className="h-4 w-1/3" />
                  </div>
                  <Skeleton className="h-6 w-16" />
                </div>
              ))}
            </Card>
          ))}
        </div>
      </div>
      <PaginationSkeleton />
    </LoadingRegion>
  );
}
