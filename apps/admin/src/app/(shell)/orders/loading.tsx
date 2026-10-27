import { ListPageSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return <ListPageSkeleton filters={8} search action columns={6} />;
}
