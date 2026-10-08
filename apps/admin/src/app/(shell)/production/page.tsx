import Link from "next/link";
import { PageHeader, Button, FilterTabs } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listBatches } from "@/lib/production/queries";
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
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const session = await requirePermission("production.manage");
  const { status: rawStatus, page } = await searchParams;
  const status = rawStatus === "draft" || rawStatus === "posted" ? (rawStatus as ProductionBatchStatus) : undefined;
  const { rows, pagination } = await listBatches(status, page);
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");

  return (
    <>
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
      <FilterTabs
        basePath="/production"
        paramName="status"
        options={STATUS_OPTIONS}
        activeValue={status}
        aria-label="Filter status batch"
      />
      <ProductionBatchList rows={rows} pagination={pagination} status={status} />
    </>
  );
}
