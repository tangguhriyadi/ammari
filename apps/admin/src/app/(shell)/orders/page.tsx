import { requirePermission } from "@/lib/auth/require-permission";
import { ComingSoonPage } from "@/components/coming-soon";

export default async function PesananPage() {
  await requirePermission("orders.view");
  return <ComingSoonPage href="/orders" title="Pesanan" description="Daftar pesanan dari semua kanal penjualan." />;
}
