import { LoadingRegion } from "@ammari/ui";
import {
  BreadcrumbSkeleton,
  FilterTabsSkeleton,
  InputSkeleton,
  ListSkeleton,
  PageHeaderSkeleton,
  PaginationSkeleton,
} from "@/components/page-skeleton";

// Two filter rows (status, payment), search, then the list.
export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton action />
      <div className="flex flex-col gap-3">
        <FilterTabsSkeleton count={6} />
        <FilterTabsSkeleton count={4} />
        <InputSkeleton />
        <ListSkeleton columns={8} />
      </div>
      <PaginationSkeleton />
    </LoadingRegion>
  );
}
