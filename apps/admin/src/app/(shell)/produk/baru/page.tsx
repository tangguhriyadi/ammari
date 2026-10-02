import { PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listFabricsWithUsage } from "@/lib/products/fabric-queries";
import { ProductForm } from "../_components/product-form";

export default async function ProdukBaruPage() {
  await requirePermission("products.manage");
  const { rows: fabrics } = await listFabricsWithUsage(undefined, undefined);

  return (
    <>
      <PageHeader title="Tambah Produk" />
      <ProductForm fabrics={fabrics} />
    </>
  );
}
