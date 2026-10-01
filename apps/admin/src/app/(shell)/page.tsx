import { requirePermission } from "@/lib/auth/require-permission";
import { ComingSoonPage } from "@/components/coming-soon";

export default async function RingkasanPage() {
  await requirePermission("overview.view");
  return <ComingSoonPage title="Ringkasan" description="Target, penjualan, dan stok dalam satu tampilan." />;
}
