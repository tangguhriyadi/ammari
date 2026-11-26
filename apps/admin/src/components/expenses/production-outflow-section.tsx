import Link from "next/link";
import { Info } from "lucide-react";
import { Button, Card, CardList, EmptyState, Input, Label, Pagination, Select, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatDate, formatRupiah } from "@ammari/ui/lib";
import { PRODUCTION_OUTFLOW_BANNER, type ProductionOutflowRow } from "@/lib/expenses/production-outflow-rows";
import { listProductionOutflows } from "@/lib/expenses/production-outflows";
import { monthToDate } from "@/lib/expenses/figures";
import { EXPENSE_MENU_PATHS, productionOutflowHref, type ProductionOutflowParams, type ProductionOutflowSourceFilter } from "@/lib/expenses/search-params";
import { formatMonthYear } from "@/lib/overview/format";
import { PAYMENT_METHOD_LABELS } from "@/lib/supplier-payments/messages";
import { PaymentStatusBadge } from "@/components/supplier-payments/payment-status-badge";

// Biaya > "Pengeluaran produksi" (docs/plans/expense-master-data.md §3.9, session S6): supplier
// payments for purchases and production batches paid in the month, read live and READ-ONLY (no
// record, edit or void control: those stay on the PO and batch pages). A card per payment on
// phones, a table on tablet/desktop. The page has checked ads_expenses.manage + finance.view_profit;
// the source number links only when the viewer may open that page.

const SOURCE_LABELS: Record<ProductionOutflowSourceFilter, string> = {
  purchase: "Pembelian",
  production: "Produksi",
};

function itemText(row: ProductionOutflowRow): string {
  return row.itemDetail ? `${row.itemLabel} (${row.itemDetail})` : row.itemLabel;
}

/** `tapTarget`: on the phone card the link is the only control, so it gets the 44px height. */
function SourceNo({ row, tapTarget = false }: { row: ProductionOutflowRow; tapTarget?: boolean }) {
  return row.sourceHref ? (
    <Link
      href={row.sourceHref}
      className={`font-medium text-brand underline-offset-2 hover:underline ${tapTarget ? "inline-flex min-h-11 items-center" : ""}`}
      data-testid="outflow-source-link"
    >
      {row.sourceNo}
    </Link>
  ) : (
    <span className="font-medium text-neutral-900" data-testid="outflow-source-text">
      {row.sourceNo}
    </span>
  );
}

export function ProductionOutflowBanner() {
  return (
    <div role="note" className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-base text-neutral-800" data-testid="production-outflow-banner">
      <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-brand" />
      <p>{PRODUCTION_OUTFLOW_BANNER}</p>
    </div>
  );
}

export function ProductionOutflowList({ rows }: { rows: ProductionOutflowRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada pembayaran produksi" description="Belum ada pembayaran ke pemasok untuk pembelian atau produksi yang cocok dengan filter ini." />;
  }
  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.id} data-testid="outflow-card">
            <Card className="flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-base font-medium text-neutral-900">
                    {row.categoryLabel} · {itemText(row)}
                  </p>
                  <p className="text-sm text-neutral-600">
                    {row.paymentNo} · {formatDate(new Date(row.paidAt))} · {PAYMENT_METHOD_LABELS[row.method]}
                  </p>
                </div>
                <span className="shrink-0 text-base font-semibold tabular-nums text-neutral-900">{formatRupiah(row.amount)}</span>
              </div>
              <p className="flex flex-wrap items-center gap-x-1 text-sm text-neutral-800">
                <SourceNo row={row} tapTarget />
                <span>· {row.payeeName}</span>
              </p>
              <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-700">
                <span data-testid="outflow-ordinal">Pembayaran ke-{row.ordinal}</span>
                <span aria-hidden="true">·</span>
                {/* The bill's current status, not this payment's (owner answer D9). */}
                <span>Tagihan:</span>
                <PaymentStatusBadge status={row.status} />
              </div>
            </Card>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>Tanggal bayar</Th>
          <Th>No. pembayaran</Th>
          <Th>Kategori / item</Th>
          <Th>Pemasok / penerima</Th>
          <Th>Sumber</Th>
          <Th>Pembayaran</Th>
          <Th>Status tagihan</Th>
          <Th>Metode</Th>
          <Th>Jumlah</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id} data-testid="outflow-row">
              <Td className="text-neutral-700">{formatDate(new Date(row.paidAt))}</Td>
              <Td className="font-medium text-neutral-900">{row.paymentNo}</Td>
              <Td className="text-neutral-700">
                {row.categoryLabel}
                <span className="block text-sm text-neutral-600">{itemText(row)}</span>
              </Td>
              <Td className="text-neutral-700">{row.payeeName}</Td>
              <Td>
                <SourceNo row={row} />
              </Td>
              <Td className="text-neutral-700" data-testid="outflow-ordinal">
                Pembayaran ke-{row.ordinal}
              </Td>
              <Td>
                <PaymentStatusBadge status={row.status} />
              </Td>
              <Td className="text-neutral-700">{PAYMENT_METHOD_LABELS[row.method]}</Td>
              <Td className="tabular-nums text-neutral-900">{formatRupiah(row.amount)}</Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}

export async function ProductionOutflowSection({
  params,
  permissionKeys,
  now,
  page,
  perPage,
}: {
  params: ProductionOutflowParams;
  permissionKeys: readonly string[];
  /** The page's clock, so "this month" here is the month the params were parsed against. */
  now: Date;
  page: string | undefined;
  perPage: string | undefined;
}) {
  const { rows, pagination, total } = await listProductionOutflows(params, permissionKeys, page, perPage);
  const basePath = EXPENSE_MENU_PATHS.operational;
  const thisMonth = monthToDate(now).month;
  return (
    <>
      <div className="flex flex-col gap-3">
        <ProductionOutflowBanner />
        <form method="GET" action={basePath} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end" aria-label="Filter pengeluaran produksi">
          <input type="hidden" name="tab" value="production" />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="outflow-month">Bulan</Label>
            <Input id="outflow-month" name="month" type="month" defaultValue={params.month} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="outflow-source">Sumber</Label>
            <Select id="outflow-source" name="source" defaultValue={params.source ?? ""}>
              <option value="">Semua sumber</option>
              {(Object.keys(SOURCE_LABELS) as ProductionOutflowSourceFilter[]).map((key) => (
                <option key={key} value={key}>
                  {SOURCE_LABELS[key]}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="outflow-q">Cari</Label>
            <Input id="outflow-q" name="q" defaultValue={params.q ?? ""} placeholder="No. pembayaran, PO, batch, pemasok" />
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit">Terapkan</Button>
            <Link href={productionOutflowHref({ month: thisMonth }, now)} className="inline-flex min-h-11 items-center text-base font-medium text-brand hover:underline">
              Reset
            </Link>
          </div>
        </form>
        <p className="text-base text-neutral-800" data-testid="outflow-total">
          Total pembayaran {formatMonthYear(params.month)}: <span className="font-semibold tabular-nums">{formatRupiah(total)}</span>
        </p>
        <ProductionOutflowList rows={rows} />
      </div>
      <Pagination
        pagination={pagination}
        basePath={basePath}
        searchParams={{
          tab: "production",
          month: params.month === thisMonth ? undefined : params.month,
          source: params.source,
          q: params.q,
          perPage,
        }}
        itemLabel="pembayaran"
      />
    </>
  );
}
