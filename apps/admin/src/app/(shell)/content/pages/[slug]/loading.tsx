import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, FormFieldsSkeleton, PageHeaderSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton />
      <div className="flex max-w-2xl flex-col gap-4">
        <FormFieldsSkeleton fields={1} />
        <Skeleton className="h-80 w-full rounded-lg" />
        <div className="flex justify-end gap-2">
          <Skeleton className="h-11 w-28" />
          <Skeleton className="h-11 w-28" />
        </div>
      </div>
    </LoadingRegion>
  );
}
