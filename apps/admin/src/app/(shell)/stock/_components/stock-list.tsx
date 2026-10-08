import Link from "next/link";
import { Badge, ColorSwatch, EmptyState } from "@ammari/ui";
import { formatNumber } from "@ammari/ui/lib";
import type { StockOverviewRow } from "@/lib/stock/queries";
import { stockStatus } from "@/lib/stock/status";

export function StockStatusBadge({ currentStock, minStockQty }: { currentStock: number; minStockQty: number }) {
  const status = stockStatus(currentStock, minStockQty);
  if (status === "habis") return <Badge variant="danger">Habis</Badge>;
  if (status === "menipis") return <Badge variant="warning">Menipis</Badge>;
  return null;
}

function groupByProduct(rows: StockOverviewRow[]) {
  const products = new Map<string, { productId: string; productName: string; rows: StockOverviewRow[] }>();
  for (const row of rows) {
    let group = products.get(row.productId);
    if (!group) {
      group = { productId: row.productId, productName: row.productName, rows: [] };
      products.set(row.productId, group);
    }
    group.rows.push(row);
  }
  return Array.from(products.values());
}

export function StockList({ rows, canAdjust }: { rows: StockOverviewRow[]; canAdjust: boolean }) {
  if (rows.length === 0) {
    return <EmptyState title="Tidak ada SKU yang cocok" description="Coba ubah kata kunci atau filter." />;
  }

  const groups = groupByProduct(rows);

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        // Grouped by product, not a flat table — a SKU only makes sense next to its siblings
        // (same color/size family), so this keeps that hierarchy instead of flattening it. Each
        // group still borrows the shared table's visual language (rounded border, same row
        // padding/hover) for consistency with every other list page.
        <div key={group.productId} className="overflow-hidden rounded-lg border border-neutral-200">
          <div className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-3">
            <h3 className="text-base font-semibold text-neutral-900">{group.productName}</h3>
            {canAdjust && (
              <Link href={`/stock/count/${group.productId}`} className="text-sm font-medium text-brand hover:underline">
                Hitung stok
              </Link>
            )}
          </div>
          <div className="flex flex-col">
            {group.rows.map((row) => (
              <Link
                key={row.sku}
                href={`/stock/${row.sku}`}
                className="flex items-center gap-3 border-b border-neutral-100 px-4 py-3 last:border-0 hover:bg-neutral-50"
              >
                <ColorSwatch hex={row.colorHex} />
                <div className="flex-1">
                  <p className="text-base text-neutral-900">
                    {row.colorName} · {row.size === "ALLSIZE" ? "All Size" : row.size}
                  </p>
                  <p className="text-sm text-neutral-600">{row.sku}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="text-base font-semibold tabular-nums text-neutral-900">{formatNumber(row.currentStock)}</span>
                  <div className="flex gap-1">
                    {!row.isActive && <Badge variant="neutral">Nonaktif</Badge>}
                    <StockStatusBadge currentStock={row.currentStock} minStockQty={row.minStockQty} />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
