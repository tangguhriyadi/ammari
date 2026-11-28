import { LoadingRegion, Skeleton } from "@ammari/ui";

export default function Loading() {
  return (
    <LoadingRegion>
      <div className="flex max-w-3xl flex-col gap-6">
        <Skeleton className="h-36 w-full rounded-lg" />
        <Skeleton className="h-11 w-full rounded-lg sm:w-64" />
      </div>
    </LoadingRegion>
  );
}
