import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listHomepageSections } from "@/lib/content/homepage";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { HomepageOverview } from "./_components/homepage-overview";

export default async function ContentBerandaPage() {
  await requirePermission("content.manage");
  const sections = await listHomepageSections();

  return (
    <>
      <Breadcrumb items={rootCrumbs("/content")} />
      <PageHeader
        title="Beranda"
        description="Kelola konten halaman utama toko online: Hero, Grid Produk, Feature Block, dan Kenapa Ammari."
      />
      <HomepageOverview initialSections={sections} />
    </>
  );
}
