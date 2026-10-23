import { Breadcrumb, PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ProductTypeForm } from "../_components/product-type-form";

export default async function NewProductTypePage() {
  await requirePermission("products.manage");
  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/product-types"), { label: "Tambah jenis produk" }]} />
      <PageHeader title="Tambah Jenis Produk" />
      <ProductTypeForm mode="create" initialValues={{ code: "", name: "", sortOrder: "0", isActive: true }} />
    </>
  );
}
