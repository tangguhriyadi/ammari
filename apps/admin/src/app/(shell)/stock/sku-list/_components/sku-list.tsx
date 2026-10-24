import { Badge, Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatNumber } from "@ammari/ui/lib";
import { sizeLabel } from "@ammari/commerce/size-label";
import type { SkuListRow } from "@/lib/stock/sku-list";

// Read-only on purpose: the SKU is the thing to copy, so it is plain selectable text (font-mono,
// select-all on tap), not a link that would navigate away mid-selection.

export function SkuList({ rows }: { rows: readonly SkuListRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Tidak ada SKU yang cocok" description="Coba ubah kata kunci atau filter." />;
  }

  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.sku}>
            <Card className="flex flex-col gap-1">
              <div className="flex items-start justify-between gap-2">
                <span className="text-base font-semibold text-neutral-900">{row.productName}</span>
                {!row.isActive && <Badge variant="neutral">Nonaktif</Badge>}
              </div>
              <span className="text-sm text-neutral-600">
                {row.colorName} · {sizeLabel(row.size)}
              </span>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-base break-all text-neutral-900 select-all">{row.sku}</span>
                <span className="shrink-0 text-sm tabular-nums text-neutral-600">Stok {formatNumber(row.stockQty)}</span>
              </div>
            </Card>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Produk</Th>
          <Th>Warna</Th>
          <Th>Ukuran</Th>
          <Th>SKU</Th>
          <Th>Status</Th>
          <Th className="text-right">Stok</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.sku}>
              <Td className="font-medium text-neutral-900">{row.productName}</Td>
              <Td className="text-neutral-700">{row.colorName}</Td>
              <Td className="text-neutral-700">{sizeLabel(row.size)}</Td>
              <Td className="font-mono text-neutral-900 select-all">{row.sku}</Td>
              <Td>{row.isActive ? <span className="text-neutral-700">Aktif</span> : <Badge variant="neutral">Nonaktif</Badge>}</Td>
              <Td className="text-right tabular-nums text-neutral-700">{formatNumber(row.stockQty)}</Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
