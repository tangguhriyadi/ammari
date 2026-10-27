import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, FormFieldsSkeleton, ListSkeleton, PageHeaderSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton description={false} />
      <Skeleton className="mb-6 h-8 w-64 max-w-full" />
      <div className="flex max-w-2xl flex-col gap-6">
        <FormFieldsSkeleton fields={7} />
        <Skeleton className="h-11 w-32" />
      </div>
      <Skeleton className="mt-8 mb-4 h-7 w-24" />
      <ListSkeleton columns={4} rows={4} />
    </LoadingRegion>
  );
}
