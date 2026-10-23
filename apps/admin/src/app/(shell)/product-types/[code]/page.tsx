import { notFound } from "next/navigation";
import { Badge, Breadcrumb, PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getProductTypeByCode } from "@/lib/product-types/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ProductTypeForm } from "../_components/product-type-form";

export default async function ProductTypeDetailPage({ params }: { params: Promise<{ code: string }> }) {
  await requirePermission("products.manage");
  const { code } = await params;
  // getProductTypeByCode returns null for anything that isn't a well-formed code, so a hand-typed
  // URL is a 404, never a query error.
  const productType = await getProductTypeByCode(code);
  if (!productType) notFound();

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/product-types"), { label: productType.name }]} />
      <div className="flex items-center justify-between gap-2">
        <PageHeader title={productType.name} description={productType.code} />
        {!productType.isActive && <Badge variant="neutral">Nonaktif</Badge>}
      </div>
      <ProductTypeForm
        mode="edit"
        code={productType.code}
        initialValues={{
          code: productType.code,
          name: productType.name,
          sortOrder: String(productType.sortOrder),
          isActive: productType.isActive,
        }}
      />
    </>
  );
}
