import Link from "next/link";
import { Breadcrumb, Button, Input, Label, PageHeader, Pagination, Select } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { listGoodsReceipts, parseReceiptListFilters } from "@/lib/receipts/list";
import { listSupplierFilterOptions } from "@/lib/suppliers/queries";
import { RECEIPT_STATUS_LABELS, ReceiptList } from "./_components/receipt-list";

// Every goods receipt, both sources (docs/plans/suppliers-goods-receipt.md §7, S7). Read-only:
// receiving and reversing stay on the purchase and batch pages.

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; supplier?: string; from?: string; to?: string; status?: string; page?: string; perPage?: string }>;
}) {
  const session = await requirePermission("inventory.view");
  const raw = await searchParams;
  const filters = parseReceiptListFilters(raw);
  const canViewProduction = session.permissionKeys.includes("production.manage");

  const [{ rows, pagination }, supplierOptions] = await Promise.all([
    listGoodsReceipts(filters, raw.page, raw.perPage),
    listSupplierFilterOptions(),
  ]);
  const hasFilters = Object.keys(filters).length > 0;

  return (
    <>
      <Breadcrumb items={rootCrumbs("/receipts")} />
      <PageHeader
        title="Penerimaan barang"
        description="Semua penerimaan dari pembelian dan hasil produksi, terbaru di atas. Terima barang dari halaman pesanan atau batch."
      />
      <form method="GET" className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end" aria-label="Filter penerimaan">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="receipts-source">Sumber</Label>
          <Select id="receipts-source" name="source" defaultValue={filters.source ?? ""}>
            <option value="">Semua</option>
            <option value="purchase">Pembelian</option>
            <option value="production_batch">Produksi</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="receipts-supplier">Supplier</Label>
          <Select id="receipts-supplier" name="supplier" defaultValue={filters.supplierId ?? ""}>
            <option value="">Semua</option>
            {supplierOptions.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.isActive ? supplier.name : `${supplier.name} (nonaktif)`}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="receipts-from">Dari tanggal</Label>
          <Input id="receipts-from" name="from" type="date" defaultValue={filters.dateFrom ?? ""} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="receipts-to">Sampai tanggal</Label>
          <Input id="receipts-to" name="to" type="date" defaultValue={filters.dateTo ?? ""} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="receipts-status">Status</Label>
          <Select id="receipts-status" name="status" defaultValue={filters.status ?? ""}>
            <option value="">Semua</option>
            <option value="active">{RECEIPT_STATUS_LABELS.active}</option>
            <option value="reversed">{RECEIPT_STATUS_LABELS.reversed}</option>
            <option value="reversal">{RECEIPT_STATUS_LABELS.reversal}</option>
          </Select>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit">Terapkan</Button>
          {hasFilters && (
            <Link href="/receipts" className="text-base font-medium text-brand hover:underline">
              Reset
            </Link>
          )}
        </div>
      </form>
      <ReceiptList rows={rows} canViewProduction={canViewProduction} filtered={hasFilters} />
      <Pagination
        pagination={pagination}
        basePath="/receipts"
        searchParams={{
          source: filters.source,
          supplier: filters.supplierId,
          from: filters.dateFrom,
          to: filters.dateTo,
          status: filters.status,
          perPage: raw.perPage,
        }}
        itemLabel="penerimaan"
      />
    </>
  );
}
