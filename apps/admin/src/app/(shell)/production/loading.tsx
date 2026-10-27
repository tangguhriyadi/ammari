import { LoadingRegion } from "@ammari/ui";
import {
  BreadcrumbSkeleton,
  FilterTabsSkeleton,
  ListSkeleton,
  PageHeaderSkeleton,
  PaginationSkeleton,
} from "@/components/page-skeleton";

// Two filter rows (status, payment), then the list.
export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton action />
      <div className="flex flex-col gap-3">
        <FilterTabsSkeleton count={3} />
        <FilterTabsSkeleton count={4} />
        <ListSkeleton columns={9} />
      </div>
      <PaginationSkeleton />
    </LoadingRegion>
  );
}
