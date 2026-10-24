import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Breadcrumb, Card, CardList, EmptyState, PageHeader, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatDateTime, formatNumber, formatRupiah } from "@ammari/ui/lib";
import { requirePermission } from "@/lib/auth/require-permission";
import { getImportBatchDetail, type ImportedChange, type ImportBatchOrderRow } from "@/lib/marketplace-import/history";
import { FEE_COMPONENT_LABELS } from "@/lib/marketplace-import/preview-view";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { ORDER_STATUS_BADGE_VARIANT, ORDER_STATUS_LABELS } from "@/lib/orders/status-labels";
import type { ChannelFeeComponent } from "@ammari/db/schema";
import { countsText } from "../_components/import-history";

// One committed upload (docs/plans/marketplace-import.md §11): which orders it created or updated,
// each linked to its order page. Money only with finance.view_profit (history.ts strips it).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function money(amount: number | null): string | null {
  return amount === null ? null : formatRupiah(amount);
}

function changeText(change: ImportedChange): string {
  switch (change.kind) {
    case "status":
      return change.before ? `Status: ${ORDER_STATUS_LABELS[change.before]} → ${ORDER_STATUS_LABELS[change.after]}` : `Dibuat, status ${ORDER_STATUS_LABELS[change.after]}`;
    case "return_pending":
      return change.value === "set" ? "Ditandai retur di marketplace" : "Tanda retur di marketplace dihapus";
    case "voucher": {
      const before = money(change.before);
      const after = money(change.after);
      return before !== null || after !== null ? `Voucher penjual: ${before ?? "belum ada"} → ${after ?? "-"}` : "Voucher penjual berubah";
    }
    case "fee": {
      const label = FEE_COMPONENT_LABELS[change.component as ChannelFeeComponent] ?? change.component;
      const after = money(change.after);
      return after !== null ? `${label}: ${money(change.before) ?? "belum ada"} → ${after}` : `${label} berubah`;
    }
    case "channel_status":
      return `Status marketplace: ${change.before ?? "belum ada"} → ${change.after}`;
    case "sku_match":
      return `Dicocokkan: ${change.fileSku} ke ${change.adminSku}`;
  }
}

function Changes({ row }: { row: ImportBatchOrderRow }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {row.changes.map((change, index) => (
        <li key={index} className="text-sm text-neutral-700">
          {changeText(change)}
        </li>
      ))}
    </ul>
  );
}

export default async function ImportBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("orders.import");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const batch = await getImportBatchDetail(id, { canViewProfit });
  if (!batch) notFound();
  const title = `Impor ${formatDateTime(batch.committedAt)}`;

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/import"), { label: title }]} />
      <PageHeader title={title} description={`${batch.channelName} · ${batch.filename} · oleh ${batch.uploadedByName}`} />
      <Card className="flex flex-col gap-1">
        <p className="text-base text-neutral-900" data-testid="import-batch-counts">
          {countsText(batch.counts)}
          {batch.counts ? `, ${formatNumber(batch.counts.unchanged)} tidak berubah, ${formatNumber(batch.counts.skip)} dilewati` : ""}
        </p>
        {batch.rowCount !== null && <p className="text-sm text-neutral-600">{formatNumber(batch.rowCount)} baris di file</p>}
        {canViewProfit && batch.newOmzetAmount !== null && <p className="text-sm text-neutral-600">Omzet pesanan baru {formatRupiah(batch.newOmzetAmount)}</p>}
        {batch.skuMatches.length > 0 && (
          <div className="flex flex-col gap-0.5 pt-1">
            <p className="text-sm font-medium text-neutral-900">Dicocokkan manual</p>
            {batch.skuMatches.map((match) => (
              <p key={match.fileSku} className="text-sm text-neutral-700">
                <span className="font-mono">{match.fileSku}</span> ke <span className="font-mono">{match.adminSku}</span> ({match.channelOrderNos.join(", ")})
              </p>
            ))}
          </div>
        )}
      </Card>

      <h2 className="text-lg font-semibold text-neutral-900">Pesanan</h2>
      {batch.orders.length === 0 ? (
        <EmptyState title="Tidak ada pesanan" description="Impor ini tidak membuat atau mengubah pesanan." />
      ) : (
        <>
          <CardList>
            {batch.orders.map((row) => (
              <li key={row.orderId}>
                <Card className="flex flex-col gap-1">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/orders/${row.orderId}`} className="text-base font-semibold text-neutral-900 underline underline-offset-4">
                      {row.orderNo}
                    </Link>
                    <Badge variant={ORDER_STATUS_BADGE_VARIANT[row.status]}>{ORDER_STATUS_LABELS[row.status]}</Badge>
                  </div>
                  <span className="font-mono text-sm break-all text-neutral-600">{row.channelOrderNo}</span>
                  <span className="text-sm text-neutral-600">{row.action === "created" ? "Baru" : "Diperbarui"}</span>
                  <Changes row={row} />
                </Card>
              </li>
            ))}
          </CardList>
          <TableContainer>
            <TableHead>
              <Th>Pesanan</Th>
              <Th>No. marketplace</Th>
              <Th>Aksi</Th>
              <Th>Perubahan</Th>
              <Th>Status sekarang</Th>
            </TableHead>
            <tbody>
              {batch.orders.map((row) => (
                <Tr key={row.orderId}>
                  <Td>
                    <Link href={`/orders/${row.orderId}`} className="font-medium text-neutral-900 underline underline-offset-4">
                      {row.orderNo}
                    </Link>
                  </Td>
                  <Td className="font-mono text-neutral-700">{row.channelOrderNo}</Td>
                  <Td className="text-neutral-700">{row.action === "created" ? "Baru" : "Diperbarui"}</Td>
                  <Td>
                    <Changes row={row} />
                  </Td>
                  <Td>
                    <Badge variant={ORDER_STATUS_BADGE_VARIANT[row.status]}>{ORDER_STATUS_LABELS[row.status]}</Badge>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableContainer>
        </>
      )}
    </>
  );
}
