import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, FormFieldsSkeleton, PageHeaderSkeleton, SectionSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-4">
        <Skeleton className="h-11 w-48" />
        <div className="max-w-xl">
          <FormFieldsSkeleton fields={2} />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-7 w-20" />
          {Array.from({ length: 4 }, (_, index) => (
            <SectionSkeleton key={index} lines={3} />
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}
