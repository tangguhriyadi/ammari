import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listAllFabricsWithUsage } from "@/lib/products/fabric-queries";
import { listActiveProductTypeOptions } from "@/lib/product-types/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ProductForm } from "../_components/product-form";

export default async function ProdukBaruPage() {
  await requirePermission("products.manage");
  const [fabrics, productTypes] = await Promise.all([listAllFabricsWithUsage(), listActiveProductTypeOptions()]);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/products"), { label: "Tambah produk" }]} />
      <PageHeader title="Tambah Produk" />
      <ProductForm fabrics={fabrics} productTypes={productTypes} />
    </>
  );
}
