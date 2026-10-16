import { notFound } from "next/navigation";
import { PageHeader, Breadcrumb } from "@ammari/ui";
import { INFO_PAGE_SLUGS, type InfoPageSlug } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { getInfoPage } from "@/lib/content/info-pages";
import { INFO_PAGE_LABELS } from "@/lib/content/info-pages-types";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { InfoPageForm } from "../_components/info-page-form";

function parseSlug(raw: string): InfoPageSlug | null {
  return (INFO_PAGE_SLUGS as readonly string[]).includes(raw) ? (raw as InfoPageSlug) : null;
}

export default async function ContentInfoPagePage({ params }: { params: Promise<{ slug: string }> }) {
  await requirePermission("content.manage");
  const { slug: rawSlug } = await params;
  const slug = parseSlug(rawSlug);
  if (!slug) notFound();

  const page = await getInfoPage(slug);
  if (!page) notFound();

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/content/pages"), { label: INFO_PAGE_LABELS[slug] }]} />
      <PageHeader title={INFO_PAGE_LABELS[slug]} description="Tulis draf, lalu klik Terbitkan agar tampil di toko online." />
      <InfoPageForm slug={slug} initialValues={{ title: page.title, bodyHtml: page.draftBody }} isPublished={page.publishedBody !== null} />
    </>
  );
}
