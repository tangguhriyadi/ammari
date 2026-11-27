import { LoadingRegion } from "@ammari/ui";
import { BreadcrumbSkeleton, ListSkeleton, PageHeaderSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton action />
      <ListSkeleton columns={3} />
    </LoadingRegion>
  );
}
