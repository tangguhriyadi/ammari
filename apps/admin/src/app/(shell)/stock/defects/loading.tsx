import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, FilterTabsSkeleton, ListSkeleton, PageHeaderSkeleton } from "@/components/page-skeleton";

// Stock type tabs, then two headed lists: finished goods and fabric/accessories.
export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-3">
        <FilterTabsSkeleton count={4} />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-7 w-32" />
          <ListSkeleton columns={4} rows={4} />
        </div>
        <div className="mt-3 flex flex-col gap-3">
          <Skeleton className="h-7 w-44" />
          <ListSkeleton columns={4} rows={4} />
        </div>
      </div>
    </LoadingRegion>
  );
}
