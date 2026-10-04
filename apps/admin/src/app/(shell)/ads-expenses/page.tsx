import { requirePermission } from "@/lib/auth/require-permission";
import { ComingSoonPage } from "@/components/coming-soon";

export default async function IklanBiayaPage() {
  await requirePermission("ads_expenses.manage");
  return <ComingSoonPage title="Iklan & Biaya" description="Pengeluaran iklan dan biaya operasional harian." />;
}
