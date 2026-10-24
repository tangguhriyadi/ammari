import { Breadcrumb, PageHeader } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listImportBatches } from "@/lib/marketplace-import/history";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ImportHistory } from "./_components/import-history";
import { ImportWorkbench } from "./_components/import-workbench";

// Impor pesanan marketplace (docs/plans/marketplace-import.md §11, session 5).

export default async function ImportPage() {
  const session = await requirePermission("orders.import");
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const history = await listImportBatches({ canViewProfit });

  return (
    <>
      <Breadcrumb items={rootCrumbs("/import")} />
      <PageHeader title="Impor pesanan marketplace" description="Unggah file export Pesanan dari Seller Center. Data pembeli tidak disimpan." />
      <ImportWorkbench />
      <section aria-labelledby="import-history-heading" className="flex flex-col gap-3">
        <h2 id="import-history-heading" className="text-lg font-semibold text-neutral-900">
          Riwayat impor
        </h2>
        <ImportHistory rows={history} canViewProfit={canViewProfit} />
      </section>
    </>
  );
}
