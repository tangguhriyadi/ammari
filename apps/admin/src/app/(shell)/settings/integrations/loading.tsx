import { LoadingRegion } from "@ammari/ui";
import { BreadcrumbSkeleton, PageHeaderSkeleton } from "@/components/page-skeleton";

// Shown while /settings/integrations picks a tab, instead of the Pengaturan form skeleton.
export default function Loading() {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <PageHeaderSkeleton />
    </LoadingRegion>
  );
}
