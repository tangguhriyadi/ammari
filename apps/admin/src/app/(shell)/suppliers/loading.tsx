import { ListPageSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return <ListPageSkeleton filters={3} search action columns={5} />;
}
