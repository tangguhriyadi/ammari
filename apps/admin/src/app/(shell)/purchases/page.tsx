import Link from "next/link";
import { PageHeader, Button, Input, Tabs, Pagination, Breadcrumb } from "@ammari/ui";
import { PURCHASE_STATUSES, type PurchaseStatus } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { hasLegacyPurchases, stripPurchaseAmounts } from "@/lib/inventory/purchases";
import {
  listPurchaseDocuments,
  PURCHASE_PAYMENT_FILTERS,
  stripPurchaseListPaymentAmounts,
  type PurchasePaymentFilter,
} from "@/lib/purchases/queries";
import { PURCHASE_STATUS_LABELS } from "@/lib/purchases/status";
import { PAYMENT_STATUS_LABELS } from "@/lib/supplier-payments/status";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { PurchaseDocumentList } from "./_components/purchase-document-list";

const STATUS_FILTER_OPTIONS = [
  { label: "Semua", value: undefined },
  ...PURCHASE_STATUSES.map((status) => ({ label: PURCHASE_STATUS_LABELS[status], value: status })),
];

// docs/plans/purchase-payments.md §9: "Tanpa tagihan" is listed under "Semua" only, and "Lunas"
// includes "Lebih bayar".
const PAYMENT_FILTER_OPTIONS = [
  { label: "Semua", value: undefined },
  ...PURCHASE_PAYMENT_FILTERS.map((payment) => ({ label: PAYMENT_STATUS_LABELS[payment], value: payment })),
];

function parseStatus(raw: string | undefined): PurchaseStatus | undefined {
  return PURCHASE_STATUSES.find((status) => status === raw);
}

function parsePayment(raw: string | undefined): PurchasePaymentFilter | undefined {
  return PURCHASE_PAYMENT_FILTERS.find((payment) => payment === raw);
}

/** The two filter rows combine, so each tab keeps the other row's choice and the search (FilterTabs
 * builds a single-param link, which would drop them). Paging restarts at 1. */
function listHref(params: { status?: string; payment?: string; q?: string }): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const query = search.toString();
  return query ? `/purchases?${query}` : "/purchases";
}

export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; payment?: string; page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const { q, status: rawStatus, payment: rawPayment, page, perPage } = await searchParams;
  const status = parseStatus(rawStatus);
  const payment = parsePayment(rawPayment);
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const canManage = session.permissionKeys.includes("inventory.manage");

  const [{ rows, pagination }, showLegacyLink] = await Promise.all([
    listPurchaseDocuments({ status, payment, q }, page, perPage),
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
        <Tabs
          aria-label="Filter status pesanan"
          items={STATUS_FILTER_OPTIONS.map((option) => ({
            label: option.label,
            href: listHref({ status: option.value, payment, q }),
            isActive: option.value === status,
          }))}
        />
        <Tabs
          aria-label="Filter status pembayaran"
          items={PAYMENT_FILTER_OPTIONS.map((option) => ({
            label: option.label,
            href: listHref({ status, payment: option.value, q }),
            isActive: option.value === payment,
          }))}
        />
        <form method="GET">
          {status && <input type="hidden" name="status" value={status} />}
          {payment && <input type="hidden" name="payment" value={payment} />}
          <Input name="q" defaultValue={q ?? ""} placeholder="Cari nomor pesanan atau supplier..." aria-label="Cari pesanan pembelian" />
        </form>
        <PurchaseDocumentList rows={stripPurchaseListPaymentAmounts(stripPurchaseAmounts(rows, canViewProfit), canViewProfit)} />
      </div>
      <Pagination
        pagination={pagination}
        basePath="/purchases"
        searchParams={{ q, status, payment, perPage }}
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
