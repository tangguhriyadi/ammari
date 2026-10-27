import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, FormFieldsSkeleton, PageHeaderSkeleton } from "@/components/page-skeleton";

function FormBlockSkeleton({ fields }: { fields: number }) {
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-5 w-80 max-w-full" />
      </div>
      <FormFieldsSkeleton fields={fields} />
      <div className="flex justify-end">
        <Skeleton className="h-11 w-28" />
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-10">
        <FormBlockSkeleton fields={2} />
        <FormBlockSkeleton fields={3} />
      </div>
    </LoadingRegion>
  );
}
