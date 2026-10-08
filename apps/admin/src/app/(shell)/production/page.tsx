import Link from "next/link";
import { PageHeader, Button, FilterTabs, Pagination, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listBatches } from "@/lib/production/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ProductionBatchList } from "./_components/production-batch-list";
import type { ProductionBatchStatus } from "@ammari/db/schema";

const STATUS_OPTIONS = [
  { label: "Semua", value: undefined },
  { label: "Draf", value: "draft" },
  { label: "Diposting", value: "posted" },
] as const;

export default async function ProductionPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("production.manage");
  const { status: rawStatus, page, perPage } = await searchParams;
  const status = rawStatus === "draft" || rawStatus === "posted" ? (rawStatus as ProductionBatchStatus) : undefined;
  const { rows, pagination } = await listBatches(status, page, perPage);
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");

  return (
    <>
      <Breadcrumb items={rootCrumbs("/production")} />
      <PageHeader
        title="Produksi"
        description="Batch produksi dan kuantitasnya."
        actions={
          <div className="flex items-center gap-2">
            {canViewProfit && (
              <Link href="/production/cost-components">
                <Button variant="secondary">Komponen biaya</Button>
              </Link>
            )}
            <Link href="/production/new">
              <Button>Batch baru</Button>
            </Link>
          </div>
        }
      />
      <div className="flex flex-col gap-3">
        <FilterTabs
          basePath="/production"
          paramName="status"
          options={STATUS_OPTIONS}
          activeValue={status}
          aria-label="Filter status batch"
        />
        <ProductionBatchList rows={rows} />
      </div>
      <Pagination pagination={pagination} basePath="/production" searchParams={{ status, perPage }} itemLabel="batch" />
    </>
  );
}
