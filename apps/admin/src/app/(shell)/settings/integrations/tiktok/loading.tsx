import { LoadingRegion, Skeleton } from "@ammari/ui";

export default function Loading() {
  return (
    <LoadingRegion>
      <div className="flex max-w-3xl flex-col gap-6">
        <Skeleton className="h-72 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-56 w-full rounded-lg" />
      </div>
    </LoadingRegion>
  );
}
