import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, FilterTabsSkeleton, PageHeaderSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton />
      <div className="mb-4">
        <FilterTabsSkeleton count={2} />
      </div>
      <div className="mb-6">
        <FilterTabsSkeleton count={2} />
      </div>
      <div className="flex flex-col gap-6">
        <Skeleton className="h-48 w-full rounded-lg" />
        <Skeleton className="h-72 w-full rounded-lg" />
      </div>
    </LoadingRegion>
  );
}
