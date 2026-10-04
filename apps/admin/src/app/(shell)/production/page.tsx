import { requirePermission } from "@/lib/auth/require-permission";
import { ComingSoonPage } from "@/components/coming-soon";

export default async function ProduksiPage() {
  await requirePermission("production.manage");
  return <ComingSoonPage title="Produksi" description="Batch produksi dan kuantitasnya." />;
}
