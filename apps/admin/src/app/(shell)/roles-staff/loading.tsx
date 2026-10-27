import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, FilterTabsSkeleton, ListSkeleton, PageHeaderSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-4">
        <FilterTabsSkeleton count={2} />
        <Skeleton className="h-11 w-32" />
        <FilterTabsSkeleton count={4} />
        <ListSkeleton columns={5} rows={6} />
      </div>
    </LoadingRegion>
  );
}
