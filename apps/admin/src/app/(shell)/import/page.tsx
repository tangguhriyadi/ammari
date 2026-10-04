import { requirePermission } from "@/lib/auth/require-permission";
import { ComingSoonPage } from "@/components/coming-soon";

export default async function ImporPage() {
  await requirePermission("orders.import");
  return <ComingSoonPage title="Impor" description="Unggah data pesanan dan pendapatan Shopee/TikTok Shop." />;
}
