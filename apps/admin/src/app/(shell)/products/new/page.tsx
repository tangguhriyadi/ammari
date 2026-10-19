import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listAllFabricsWithUsage } from "@/lib/products/fabric-queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ProductForm } from "../_components/product-form";

export default async function ProdukBaruPage() {
  await requirePermission("products.manage");
  const fabrics = await listAllFabricsWithUsage();

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/products"), { label: "Tambah produk" }]} />
      <PageHeader title="Tambah Produk" />
      <ProductForm fabrics={fabrics} />
    </>
  );
}
