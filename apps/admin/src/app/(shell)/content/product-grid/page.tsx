import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getHomepageSection, listHomepageSections, listPublishableProducts } from "@/lib/content/homepage";
import { productGridContentSchema } from "@/lib/content/homepage-schemas";
import { HOMEPAGE_SECTION_LABELS, sectionHasUnpublishedChanges } from "@/lib/content/homepage-types";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ProductGridForm, type ProductGridFormValues } from "../_components/product-grid-form";

export default async function ContentProductGridPage() {
  await requirePermission("content.manage");
  const [section, products, allSections] = await Promise.all([
    getHomepageSection("product_grid"),
    listPublishableProducts(),
    listHomepageSections(),
  ]);
  const unpublishedSectionLabels = allSections.filter(sectionHasUnpublishedChanges).map((row) => HOMEPAGE_SECTION_LABELS[row.key]);

  const parsed = section ? productGridContentSchema.safeParse(section.draftContent) : null;
  const initialValues: ProductGridFormValues = parsed?.success
    ? { isVisible: section!.draftIsVisible, title: parsed.data.title, tiles: parsed.data.tiles }
    : { isVisible: section?.draftIsVisible ?? true, title: "", tiles: [] };

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/content"), { label: "Grid Produk" }]} />
      <PageHeader title="Grid Produk" description="Daftar produk pilihan yang ditampilkan di halaman utama." />
      <ProductGridForm initialValues={initialValues} products={products} initialUnpublishedSectionLabels={unpublishedSectionLabels} />
    </>
  );
}
