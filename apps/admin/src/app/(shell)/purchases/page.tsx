import Link from "next/link";
import { PageHeader, Button, Input, FilterTabs, Pagination, Breadcrumb } from "@ammari/ui";
import { PURCHASE_STATUSES, type PurchaseStatus } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { hasLegacyPurchases, stripPurchaseAmounts } from "@/lib/inventory/purchases";
import { listPurchaseDocuments } from "@/lib/purchases/queries";
import { PURCHASE_STATUS_LABELS } from "@/lib/purchases/status";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { PurchaseDocumentList } from "./_components/purchase-document-list";

const STATUS_FILTER_OPTIONS = [
  { label: "Semua", value: undefined },
  ...PURCHASE_STATUSES.map((status) => ({ label: PURCHASE_STATUS_LABELS[status], value: status })),
];

function parseStatus(raw: string | undefined): PurchaseStatus | undefined {
  return PURCHASE_STATUSES.find((status) => status === raw);
}

export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const { q, status: rawStatus, page, perPage } = await searchParams;
  const status = parseStatus(rawStatus);
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canManage = session.permissionKeys.includes("inventory.manage");

  const [{ rows, pagination }, showLegacyLink] = await Promise.all([
    listPurchaseDocuments({ status, q }, page, perPage),
    hasLegacyPurchases(),
  ]);

  return (
    <>
      <Breadcrumb items={rootCrumbs("/purchases")} />
      <PageHeader
        title="Pembelian"
        description="Pesanan pembelian bahan dan aksesoris. Stok bertambah saat barang diterima."
        actions={
          canManage ? (
            <Link href="/purchases/new">
              <Button>Buat pesanan</Button>
            </Link>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-3">
        <FilterTabs
          basePath="/purchases"
          paramName="status"
          options={STATUS_FILTER_OPTIONS}
          activeValue={status}
          aria-label="Filter status pesanan"
        />
        <form method="GET">
          {status && <input type="hidden" name="status" value={status} />}
          <Input name="q" defaultValue={q ?? ""} placeholder="Cari nomor pesanan atau supplier..." aria-label="Cari pesanan pembelian" />
        </form>
        <PurchaseDocumentList rows={stripPurchaseAmounts(rows, canViewProfit)} />
      </div>
      <Pagination
        pagination={pagination}
        basePath="/purchases"
        searchParams={{ q, status, perPage }}
        itemLabel="pesanan"
      />
      {showLegacyLink && (
        <p className="mt-4">
          <Link href="/purchases/legacy" className="text-base font-medium text-brand hover:underline">
            Lihat pembelian lama (sebelum ada pesanan pembelian)
          </Link>
        </p>
      )}
    </>
  );
}
