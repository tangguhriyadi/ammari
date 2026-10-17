import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getHomepageSection, listHomepageSections } from "@/lib/content/homepage";
import { whyAmmariContentSchema } from "@/lib/content/homepage-schemas";
import { HOMEPAGE_SECTION_LABELS, sectionHasUnpublishedChanges } from "@/lib/content/homepage-types";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { WhyAmmariForm, type WhyAmmariFormValues } from "../_components/why-ammari-form";

export default async function ContentWhyAmmariPage() {
  await requirePermission("content.manage");
  const [section, allSections] = await Promise.all([getHomepageSection("why_ammari"), listHomepageSections()]);
  const unpublishedSectionLabels = allSections.filter(sectionHasUnpublishedChanges).map((row) => HOMEPAGE_SECTION_LABELS[row.key]);

  const parsed = section ? whyAmmariContentSchema.safeParse(section.draftContent) : null;
  const initialValues: WhyAmmariFormValues = parsed?.success
    ? { isVisible: section!.draftIsVisible, eyebrow: parsed.data.eyebrow, heading: parsed.data.heading, points: parsed.data.points }
    : { isVisible: section?.draftIsVisible ?? true, eyebrow: "", heading: "", points: [] };

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/content"), { label: "Kenapa Ammari" }]} />
      <PageHeader title="Kenapa Ammari" description="Poin-poin keunggulan brand di halaman utama." />
      <WhyAmmariForm initialValues={initialValues} initialUnpublishedSectionLabels={unpublishedSectionLabels} />
    </>
  );
}
