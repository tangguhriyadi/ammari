import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getHomepageSection, listPublishableProducts } from "@/lib/content/homepage";
import { heroContentSchema } from "@/lib/content/homepage-schemas";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { HeroForm, type HeroFormValues } from "../_components/hero-form";

export default async function ContentHeroPage() {
  await requirePermission("content.manage");
  const [section, products] = await Promise.all([getHomepageSection("hero"), listPublishableProducts()]);

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
      }
    : {
        isVisible: section?.draftIsVisible ?? true,
        eyebrow: "",
        headline: "",
        ctaLabel: "",
        ctaTargetType: "anchor",
        ctaProduct: null,
      };

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/content"), { label: "Hero" }]} />
      <PageHeader title="Hero" description="Bagian pertama yang dilihat pengunjung di halaman utama." />
      <HeroForm initialValues={initialValues} products={products} />
    </>
  );
}
