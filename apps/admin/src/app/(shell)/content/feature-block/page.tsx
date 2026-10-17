import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getHomepageSection, listHomepageSections, listPublishableProducts } from "@/lib/content/homepage";
import { featureBlockContentSchema, type ContentImage } from "@/lib/content/homepage-schemas";
import { buildContentImagePreviewUrl } from "@/lib/content/content-image-queries";
import { HOMEPAGE_SECTION_LABELS, sectionHasUnpublishedChanges } from "@/lib/content/homepage-types";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { FeatureBlockForm, type FeatureBlockFormValues } from "../_components/feature-block-form";
import type { ContentImageFieldValue } from "../_components/content-image-field";

function toFieldValue(image: ContentImage | null): ContentImageFieldValue | null {
  if (!image) return null;
  // feature_block has no mobile-crop UI, but the shared schema still carries the (always-null,
  // for this section) mobile* fields — nothing to surface here either way.
  return {
    storageKey: image.storageKey,
    altText: image.altText,
    width: image.width,
    height: image.height,
    previewUrl: buildContentImagePreviewUrl(image.storageKey),
    mobile: null,
  };
}

export default async function ContentFeatureBlockPage() {
  await requirePermission("content.manage");
  const [section, products, allSections] = await Promise.all([
    getHomepageSection("feature_block"),
    listPublishableProducts(),
    listHomepageSections(),
  ]);
  const unpublishedSectionLabels = allSections.filter(sectionHasUnpublishedChanges).map((row) => HOMEPAGE_SECTION_LABELS[row.key]);

  const parsed = section ? featureBlockContentSchema.safeParse(section.draftContent) : null;
  const initialValues: FeatureBlockFormValues = parsed?.success
    ? {
        isVisible: section!.draftIsVisible,
        title: parsed.data.title,
        subtitle: parsed.data.subtitle,
        ctaLabel: parsed.data.ctaLabel,
        linkedProduct: parsed.data.linkedProduct,
        image: toFieldValue(parsed.data.image),
      }
    : { isVisible: section?.draftIsVisible ?? true, title: "", subtitle: "", ctaLabel: "", linkedProduct: null, image: null };

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/content"), { label: "Feature Block" }]} />
      <PageHeader title="Feature Block" description="Blok produk unggulan di halaman utama." />
      <FeatureBlockForm initialValues={initialValues} products={products} initialUnpublishedSectionLabels={unpublishedSectionLabels} />
    </>
  );
}
