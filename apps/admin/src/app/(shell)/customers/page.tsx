import { requirePermission } from "@/lib/auth/require-permission";
import { ComingSoonPage } from "@/components/coming-soon";

export default async function PelangganVoucherPage() {
  await requirePermission("customers.view");
  return <ComingSoonPage href="/customers" title="Pelanggan & Voucher" description="Data pelanggan dan voucher kartu terima kasih." />;
}
