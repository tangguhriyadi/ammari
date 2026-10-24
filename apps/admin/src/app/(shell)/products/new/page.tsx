import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listAllFabricsWithUsage } from "@/lib/products/fabric-queries";
import { listActiveProductTypeOptions } from "@/lib/product-types/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ProductForm } from "../_components/product-form";
import { ProductStepper } from "../_components/product-stepper";

/** Step 1 of creating a product: "Lanjut" saves it as a draft and opens step 2 of
 * `/products/[id]/setup` (docs/plans/product-stepper.md). */
export default async function ProdukBaruPage() {
  await requirePermission("products.manage");
  const [fabrics, productTypes] = await Promise.all([listAllFabricsWithUsage(), listActiveProductTypeOptions()]);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/products"), { label: "Tambah produk" }]} />
      <PageHeader title="Tambah Produk" />
      <ProductStepper mode="create" productId={null} current="info" reached="info" hasVariants={false}>
        <ProductForm fabrics={fabrics} productTypes={productTypes} />
        {/* DiscountSection checks against the SAVED base price, so it needs the product first. */}
        <section className="mt-8 flex max-w-xl flex-col gap-1 rounded-lg border border-dashed border-neutral-300 p-4" aria-labelledby="discount-later-heading">
          <h2 id="discount-later-heading" className="text-lg font-semibold text-neutral-900">
            Diskon
          </h2>
          <p className="text-sm text-neutral-600">
            Diskon bisa diatur setelah produk tersimpan. Tekan Lanjut, lalu kembali ke langkah ini lewat tombol Kembali.
          </p>
        </section>
      </ProductStepper>
    </>
  );
}
