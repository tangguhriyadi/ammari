import { ListPageSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return <ListPageSkeleton action columns={8} pagination={false} />;
}
