import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getHomepageSection, listPublishableProducts } from "@/lib/content/homepage";
import { productGridContentSchema } from "@/lib/content/homepage-schemas";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ProductGridForm, type ProductGridFormValues } from "../_components/product-grid-form";

export default async function ContentProductGridPage() {
  await requirePermission("content.manage");
  const [section, products] = await Promise.all([getHomepageSection("product_grid"), listPublishableProducts()]);

  const parsed = section ? productGridContentSchema.safeParse(section.draftContent) : null;
  const initialValues: ProductGridFormValues = parsed?.success
    ? { isVisible: section!.draftIsVisible, title: parsed.data.title, tiles: parsed.data.tiles }
    : { isVisible: section?.draftIsVisible ?? true, title: "", tiles: [] };

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/content"), { label: "Grid Produk" }]} />
      <PageHeader title="Grid Produk" description="Daftar produk pilihan yang ditampilkan di halaman utama." />
      <ProductGridForm initialValues={initialValues} products={products} />
    </>
  );
}
