import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, PageHeaderSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton action />
      <Skeleton className="mb-6 h-8 w-72 max-w-full" />
    </LoadingRegion>
  );
}
