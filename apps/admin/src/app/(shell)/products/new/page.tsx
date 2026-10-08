import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listFabricsWithUsage } from "@/lib/products/fabric-queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ProductForm } from "../_components/product-form";

export default async function ProdukBaruPage() {
  await requirePermission("products.manage");
  const { rows: fabrics } = await listFabricsWithUsage(undefined, undefined, undefined);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/products"), { label: "Tambah produk" }]} />
      <PageHeader title="Tambah Produk" />
      <ProductForm fabrics={fabrics} />
    </>
  );
}
