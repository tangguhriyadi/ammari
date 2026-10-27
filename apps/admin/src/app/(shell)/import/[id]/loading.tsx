import { DetailPageSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return <DetailPageSkeleton sections={[2]} table={{ columns: 5, rows: 8 }} gap="gap-0" />;
}
