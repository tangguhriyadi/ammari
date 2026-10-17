import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getHomepageSection, listHomepageSections, listPublishableProducts } from "@/lib/content/homepage";
import { heroContentSchema, type ContentImage } from "@/lib/content/homepage-schemas";
import { buildContentImagePreviewUrl } from "@/lib/content/content-image-queries";
import { HOMEPAGE_SECTION_LABELS, sectionHasUnpublishedChanges } from "@/lib/content/homepage-types";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { HeroForm, type HeroFormValues } from "../_components/hero-form";
import type { ContentImageFieldValue } from "../_components/content-image-field";

function toFieldValue(image: ContentImage | null): ContentImageFieldValue | null {
  if (!image) return null;
  return {
    storageKey: image.storageKey,
    altText: image.altText,
    width: image.width,
    height: image.height,
    previewUrl: buildContentImagePreviewUrl(image.storageKey),
    mobile:
      image.mobileStorageKey && image.mobileWidth && image.mobileHeight
        ? {
            storageKey: image.mobileStorageKey,
            width: image.mobileWidth,
            height: image.mobileHeight,
            previewUrl: buildContentImagePreviewUrl(image.mobileStorageKey),
          }
        : null,
  };
}

export default async function ContentHeroPage() {
  await requirePermission("content.manage");
  const [section, products, allSections] = await Promise.all([
    getHomepageSection("hero"),
    listPublishableProducts(),
    listHomepageSections(),
  ]);
  const unpublishedSectionLabels = allSections.filter(sectionHasUnpublishedChanges).map((row) => HOMEPAGE_SECTION_LABELS[row.key]);

  const parsed = section ? heroContentSchema.safeParse(section.draftContent) : null;
  const initialValues: HeroFormValues = parsed?.success
    ? {
        isVisible: section!.draftIsVisible,
        eyebrow: parsed.data.eyebrow,
        headline: parsed.data.headline,
        ctaLabel: parsed.data.ctaLabel,
        ctaTargetType: parsed.data.ctaTarget.type,
        ctaProduct:
          parsed.data.ctaTarget.type === "product"
            ? { productId: parsed.data.ctaTarget.productId, fabricColorId: parsed.data.ctaTarget.fabricColorId }
            : null,
        image: toFieldValue(parsed.data.image),
      }
    : {
        isVisible: section?.draftIsVisible ?? true,
        eyebrow: "",
        headline: "",
        ctaLabel: "",
        ctaTargetType: "anchor",
        ctaProduct: null,
        image: null,
      };

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/content"), { label: "Hero" }]} />
      <PageHeader title="Hero" description="Bagian pertama yang dilihat pengunjung di halaman utama." />
      <HeroForm initialValues={initialValues} products={products} initialUnpublishedSectionLabels={unpublishedSectionLabels} />
    </>
  );
}
