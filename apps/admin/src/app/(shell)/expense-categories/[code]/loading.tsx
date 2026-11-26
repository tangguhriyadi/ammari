import { DetailPageSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return <DetailPageSkeleton sections={[3]} table={{ columns: 6, rows: 4 }} />;
}
