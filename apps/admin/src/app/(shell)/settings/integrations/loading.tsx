import { LoadingRegion, Skeleton } from "@ammari/ui";

// The content area under the Integrasi tabs; the layout keeps the breadcrumb, title and tabs.
export default function Loading() {
  return (
    <LoadingRegion>
      <Skeleton className="h-36 w-full max-w-3xl rounded-lg" />
    </LoadingRegion>
  );
}
