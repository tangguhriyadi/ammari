import { DetailPageSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return <DetailPageSkeleton sections={[3]} table={{ columns: 8, rows: 4 }} gap="gap-0" />;
}
