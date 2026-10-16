import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listInfoPages } from "@/lib/content/info-pages";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { InfoPagesOverview } from "./_components/info-pages-overview";

export default async function ContentPagesPage() {
  await requirePermission("content.manage");
  const pages = await listInfoPages();

  return (
    <>
      <Breadcrumb items={rootCrumbs("/content/pages")} />
      <PageHeader
        title="Halaman Info"
        description="Kelola isi Syarat & ketentuan, Kebijakan privasi, Cara pemesanan, Pengiriman, dan Pengembalian & penukaran."
      />
      <InfoPagesOverview initialPages={pages} />
    </>
  );
}
