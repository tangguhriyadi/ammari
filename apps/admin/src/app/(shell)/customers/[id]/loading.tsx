import { DetailPageSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return <DetailPageSkeleton sections={[6, 3]} table={{ columns: 5, rows: 5 }} />;
}
