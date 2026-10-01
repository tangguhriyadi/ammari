import { requirePermission } from "@/lib/auth/require-permission";
import { ComingSoonPage } from "@/components/coming-soon";

export default async function ProdukPage() {
  await requirePermission("products.manage");
  return <ComingSoonPage title="Produk" description="Produk, varian, dan foto." />;
}
