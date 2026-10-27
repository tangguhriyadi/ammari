import { LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, ListSkeleton, PageHeaderSkeleton, PaginationSkeleton } from "@/components/page-skeleton";

// Header, the balance row (big qty + adjust buttons), then the movement ledger.
export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-11 w-36" />
      </div>
      <ListSkeleton columns={6} />
      <PaginationSkeleton />
    </LoadingRegion>
  );
}
