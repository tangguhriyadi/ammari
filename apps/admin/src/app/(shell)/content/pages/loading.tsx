import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, PageHeaderSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-[4.75rem] rounded-lg" />
        ))}
      </div>
    </LoadingRegion>
  );
}
