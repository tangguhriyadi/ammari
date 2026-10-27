import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, PageHeaderSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-4">
        <div className="flex justify-end">
          <Skeleton className="h-11 w-36" />
        </div>
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-[4.75rem] rounded-lg" />
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}
