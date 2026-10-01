import { requirePermission } from "@/lib/auth/require-permission";
import { ComingSoonPage } from "@/components/coming-soon";

export default async function PackingPage() {
  await requirePermission("packing.print_cards");
  return <ComingSoonPage title="Packing" description="Antrean packing dan cetak kartu terima kasih." />;
}
