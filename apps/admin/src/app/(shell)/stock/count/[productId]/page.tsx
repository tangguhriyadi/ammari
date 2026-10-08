import { notFound } from "next/navigation";
import { PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getProductNameAndSkus, listProductSkusForCount } from "@/lib/stock/queries";
import { StockCountForm } from "../../_components/stock-count-form";

export default async function StockCountPage({ params }: { params: Promise<{ productId: string }> }) {
  await requirePermission("stock.adjust");
  const { productId } = await params;

  const product = await getProductNameAndSkus(productId);
  if (!product) notFound();
  const skus = await listProductSkusForCount(productId);

  return (
    <>
      <PageHeader title={`Hitung stok — ${product.name}`} description="Masukkan jumlah fisik untuk setiap SKU yang berbeda dari sistem." />
      <StockCountForm productId={productId} skus={skus} />
    </>
  );
}
