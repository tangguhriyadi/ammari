import { LoadingRegion } from "@ammari/ui";
import { BreadcrumbSkeleton, ListSkeleton, PageHeaderSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton />
      <ListSkeleton columns={6} />
    </LoadingRegion>
  );
}
