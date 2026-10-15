import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getHomepageSection, listPublishableProducts } from "@/lib/content/homepage";
import { featureBlockContentSchema } from "@/lib/content/homepage-schemas";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { FeatureBlockForm, type FeatureBlockFormValues } from "../_components/feature-block-form";

export default async function ContentFeatureBlockPage() {
  await requirePermission("content.manage");
  const [section, products] = await Promise.all([getHomepageSection("feature_block"), listPublishableProducts()]);

  const parsed = section ? featureBlockContentSchema.safeParse(section.draftContent) : null;
  const initialValues: FeatureBlockFormValues = parsed?.success
    ? {
        isVisible: section!.draftIsVisible,
        title: parsed.data.title,
        subtitle: parsed.data.subtitle,
        ctaLabel: parsed.data.ctaLabel,
        linkedProduct: parsed.data.linkedProduct,
      }
    : { isVisible: section?.draftIsVisible ?? true, title: "", subtitle: "", ctaLabel: "", linkedProduct: null };

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/content"), { label: "Feature Block" }]} />
      <PageHeader title="Feature Block" description="Blok produk unggulan di halaman utama." />
      <FeatureBlockForm initialValues={initialValues} products={products} />
    </>
  );
}
