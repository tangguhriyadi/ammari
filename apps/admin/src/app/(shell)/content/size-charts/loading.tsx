import { ListPageSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return <ListPageSkeleton action columns={2} pagination={false} />;
}
