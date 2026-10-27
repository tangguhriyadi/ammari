import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, FilterTabsSkeleton, FormFieldsSkeleton, ListSkeleton, PageHeaderSkeleton } from "@/components/page-skeleton";

// Upload card (channel choice, file input, button), then the import history list.
export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-4">
        <Skeleton className="h-5 w-16" />
        <FilterTabsSkeleton count={3} />
        <FormFieldsSkeleton fields={1} />
        <Skeleton className="h-11 w-32" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-7 w-32" />
        <ListSkeleton columns={6} rows={6} />
      </div>
    </LoadingRegion>
  );
}
