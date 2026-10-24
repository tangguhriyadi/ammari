import Link from "next/link";
import { PageHeader, Button, Tabs, Pagination, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { BATCH_PAYMENT_FILTERS, listBatches, stripBatchListPaymentAmounts, type BatchPaymentFilter } from "@/lib/production/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { PAYMENT_STATUS_LABELS } from "@/lib/supplier-payments/status";
import { ProductionBatchList } from "./_components/production-batch-list";
import type { ProductionBatchStatus } from "@ammari/db/schema";

const STATUS_OPTIONS = [
  { label: "Semua", value: undefined },
  { label: "Draf", value: "draft" },
  { label: "Diposting", value: "posted" },
] as const;

// docs/plans/purchase-payments.md §9: "Tanpa tagihan" is listed under "Semua" only. Drafts have
// no tagihan, so they appear under "Semua" only too.
const PAYMENT_FILTER_OPTIONS = [
  { label: "Semua", value: undefined },
  ...BATCH_PAYMENT_FILTERS.map((payment) => ({ label: PAYMENT_STATUS_LABELS[payment], value: payment })),
];

function parsePayment(raw: string | undefined): BatchPaymentFilter | undefined {
  return BATCH_PAYMENT_FILTERS.find((payment) => payment === raw);
}

/** The two filter rows combine, so each tab keeps the other row's choice (FilterTabs builds a
 * single-param link, which would drop it). Paging restarts at 1. */
function listHref(params: { status?: string; payment?: string }): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const query = search.toString();
  return query ? `/production?${query}` : "/production";
}

export default async function ProductionPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; payment?: string; page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("production.manage");
  const { status: rawStatus, payment: rawPayment, page, perPage } = await searchParams;
  const status = rawStatus === "draft" || rawStatus === "posted" ? (rawStatus as ProductionBatchStatus) : undefined;
  const payment = parsePayment(rawPayment);
  const { rows, pagination } = await listBatches({ status, payment }, page, perPage);
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
        <Tabs
          aria-label="Filter status batch"
          items={STATUS_OPTIONS.map((option) => ({
            label: option.label,
            href: listHref({ status: option.value, payment }),
            isActive: option.value === status,
          }))}
        />
        <Tabs
          aria-label="Filter status pembayaran"
          items={PAYMENT_FILTER_OPTIONS.map((option) => ({
            label: option.label,
            href: listHref({ status, payment: option.value }),
            isActive: option.value === payment,
          }))}
        />
        {/* Amounts only for finance.view_profit (A8): the badge is for everyone. */}
        <ProductionBatchList rows={stripBatchListPaymentAmounts(rows, canViewProfit)} showBalance={canViewProfit} />
      </div>
      <Pagination pagination={pagination} basePath="/production" searchParams={{ status, payment, perPage }} itemLabel="batch" />
    </>
  );
}
