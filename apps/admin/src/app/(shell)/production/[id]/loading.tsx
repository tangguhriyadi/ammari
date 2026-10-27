import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, ListSkeleton, PageHeaderSkeleton, SectionSkeleton } from "@/components/page-skeleton";

// A posted batch: payment badge line, the batch details, then the output table.
export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton description={false} />
      <Skeleton className="mb-4 h-5 w-40" />
      <div className="flex flex-col gap-6">
        <SectionSkeleton lines={5} />
        <ListSkeleton columns={9} rows={4} />
      </div>
    </LoadingRegion>
  );
}
