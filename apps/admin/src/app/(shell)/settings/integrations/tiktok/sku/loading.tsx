import { LoadingRegion, Skeleton } from "@ammari/ui";

export default function Loading() {
  return (
    <LoadingRegion>
      <div className="flex flex-col gap-6">
        <Skeleton className="h-48 w-full rounded-lg" />
        <Skeleton className="h-72 w-full rounded-lg" />
      </div>
    </LoadingRegion>
  );
}
