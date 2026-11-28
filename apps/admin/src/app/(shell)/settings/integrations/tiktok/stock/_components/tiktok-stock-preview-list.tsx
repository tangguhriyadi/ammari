import { Badge, Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr, type BadgeVariant } from "@ammari/ui";
import { formatNumber } from "@ammari/ui/lib";
import { sizeLabel } from "@ammari/commerce/size-label";
import type { TikTokStockPreviewRow, TikTokStockPreviewState } from "@ammari/commerce/tiktok";
import { TIKTOK_STOCK_HOLD_LABELS } from "@/lib/integrations/tiktok-messages";

// The Sinkron stok preview (docs/plans/tiktok-stock-sync.md §6): phone cards below md, the table from
// md up (CLAUDE.md: both layouts, both covered by the e2e). Read only; no client code.

const STATE: Record<TikTokStockPreviewState, { label: string; variant: BadgeVariant }> = {
  change: { label: "Akan diubah", variant: "warning" },
  same: { label: "Sudah sama", variant: "success" },
  held: { label: "Ditahan", variant: "danger" },
  unmapped: { label: "Belum dipetakan", variant: "neutral" },
};

function qty(value: number | null): string {
  return value === null ? "—" : formatNumber(value);
}

function tiktokName(row: TikTokStockPreviewRow): string {
  return [row.productTitle, row.skuLabel].filter(Boolean).join(" · ") || "Tanpa nama";
}

function variantName(row: TikTokStockPreviewRow): string | null {
  return row.variant ? `${row.variant.productName} · ${row.variant.colorName} · ${sizeLabel(row.variant.size)}` : null;
}

function reason(row: TikTokStockPreviewRow): string | null {
  if (!row.holdReason) return null;
  const label = TIKTOK_STOCK_HOLD_LABELS[row.holdReason];
  return row.holdReason === "status_not_updatable" ? `${label} (${row.productStatus})` : label;
}

function StateCell({ row }: { row: TikTokStockPreviewRow }) {
  const text = reason(row);
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant={STATE[row.state].variant}>{STATE[row.state].label}</Badge>
      {text && <span className="text-sm text-neutral-600">{text}</span>}
    </div>
  );
}

export function TikTokStockPreviewList({ rows }: { rows: TikTokStockPreviewRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada produk TikTok yang terbaca" description="Produk dan stok TikTok dibaca otomatis setiap 15 menit setelah TikTok Shop terhubung." />;
  }
  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.tiktokSkuId}>
            <Card className="flex flex-col gap-1">
              <span className="text-base font-semibold break-words text-neutral-900">{tiktokName(row)}</span>
              <span className="text-sm text-neutral-700">Varian Ammari: {variantName(row) ?? "tidak ada"}</span>
              <span className="font-mono text-sm break-all text-neutral-600">SKU penjual: {row.sellerSku ?? "kosong"}</span>
              <span className="font-mono text-sm break-all text-neutral-600">ID SKU TikTok: {row.tiktokSkuId}</span>
              <span className="text-sm text-neutral-900">
                Stok TikTok sekarang <span className="font-semibold">{qty(row.tiktokQuantity)}</span> → akan menjadi <span className="font-semibold">{qty(row.target)}</span>
              </span>
              <div className="mt-1">
                <StateCell row={row} />
              </div>
            </Card>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>Produk</Th>
          <Th>Varian</Th>
          <Th>SKU</Th>
          <Th className="text-right">Stok TikTok sekarang</Th>
          <Th className="text-right">Akan menjadi</Th>
          <Th>Status</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.tiktokSkuId}>
              <Td className="font-medium text-neutral-900">{tiktokName(row)}</Td>
              <Td className="text-neutral-700">{variantName(row) ?? "Tanpa varian Ammari"}</Td>
              <Td>
                <div className="flex flex-col">
                  <span className="font-mono text-sm text-neutral-900">{row.sellerSku ?? "kosong"}</span>
                  <span className="font-mono text-xs text-neutral-600">{row.tiktokSkuId}</span>
                </div>
              </Td>
              <Td className="text-right text-neutral-900 tabular-nums">{qty(row.tiktokQuantity)}</Td>
              <Td className="text-right font-semibold text-neutral-900 tabular-nums">{qty(row.target)}</Td>
              <Td>
                <StateCell row={row} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
