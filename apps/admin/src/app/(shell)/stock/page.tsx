import { requirePermission } from "@/lib/auth/require-permission";
import { ComingSoonPage } from "@/components/coming-soon";

export default async function StokPage() {
  await requirePermission("stock.view");
  return <ComingSoonPage title="Stok" description="Stok per SKU dan riwayat pergerakannya." />;
}
