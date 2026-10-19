import Link from "next/link";
import { Card, CardList, TableContainer, TableHead, Th, Tr, Td } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import type { DefectStockMaterialRow, DefectStockSkuRow } from "@/lib/defects/queries";
import { DEFECT_ITEM_KIND_LABELS } from "@/lib/defects/labels";

// The two lists on /stock/defects (S5). Each renders both layouts — CardList for phones,
// TableContainer for tablet/desktop — like every other list page. `valueAmount` is null for a
// session without finance.view_profit, stripped by the page, never just hidden here.

function sizeLabel(size: string): string {
  return size === "ALLSIZE" ? "All Size" : size;
}

function materialQty(row: Pick<DefectStockMaterialRow, "kind" | "qty">): string {
  return row.kind === "fabric" ? `${row.qty.toFixed(2)} yard` : `${row.qty} pcs`;
}

function materialHref(row: Pick<DefectStockMaterialRow, "kind" | "id">): string {
  return row.kind === "fabric" ? `/stock/fabrics/${row.id}` : `/stock/accessories/${row.id}`;
}

function Empty() {
  return <p className="text-base text-neutral-600">Tidak ada barang cacat.</p>;
}

export function DefectSkuList({ rows }: { rows: DefectStockSkuRow[] }) {
  if (rows.length === 0) return <Empty />;
  const showValue = rows.some((row) => row.valueAmount !== null);
  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.sku} data-testid="defect-sku-card">
            <Link href={`/stock/${row.sku}`}>
              <Card className="flex flex-col gap-1">
                <p className="text-base text-neutral-900">
                  {row.productName} · {row.colorName} · {sizeLabel(row.size)}
                </p>
                <p className="font-mono text-sm text-neutral-600">{row.sku}</p>
                <p className="text-sm text-neutral-700 tabular-nums">
                  Cacat {row.qty} pcs
                  {row.valueAmount !== null && <> · {formatRupiah(row.valueAmount)}</>}
                </p>
              </Card>
            </Link>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>Produk</Th>
          <Th>SKU</Th>
          <Th>Cacat</Th>
          {showValue && <Th>Nilai</Th>}
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.sku} data-testid="defect-sku-row">
              <Td className="font-medium text-neutral-900">
                {row.productName} · {row.colorName} · {sizeLabel(row.size)}
              </Td>
              <Td>
                <Link href={`/stock/${row.sku}`} className="font-mono text-sm text-brand hover:underline">
                  {row.sku}
                </Link>
              </Td>
              <Td className="tabular-nums text-neutral-700">{row.qty} pcs</Td>
              {showValue && <Td className="tabular-nums text-neutral-700">{row.valueAmount !== null ? formatRupiah(row.valueAmount) : "-"}</Td>}
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}

export function DefectMaterialList({ rows }: { rows: DefectStockMaterialRow[] }) {
  if (rows.length === 0) return <Empty />;
  const showValue = rows.some((row) => row.valueAmount !== null);
  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={`${row.kind}:${row.id}`} data-testid="defect-material-card">
            <Link href={materialHref(row)}>
              <Card className="flex flex-col gap-1">
                <p className="text-base text-neutral-900">{row.name}</p>
                <p className="text-sm text-neutral-600">{DEFECT_ITEM_KIND_LABELS[row.kind]}</p>
                <p className="text-sm text-neutral-700 tabular-nums">
                  Cacat {materialQty(row)}
                  {row.valueAmount !== null && <> · {formatRupiah(row.valueAmount)}</>}
                </p>
              </Card>
            </Link>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>Nama</Th>
          <Th>Jenis</Th>
          <Th>Cacat</Th>
          {showValue && <Th>Nilai</Th>}
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={`${row.kind}:${row.id}`} data-testid="defect-material-row">
              <Td>
                <Link href={materialHref(row)} className="font-medium text-brand hover:underline">
                  {row.name}
                </Link>
              </Td>
              <Td className="text-neutral-700">{DEFECT_ITEM_KIND_LABELS[row.kind]}</Td>
              <Td className="tabular-nums text-neutral-700">{materialQty(row)}</Td>
              {showValue && <Td className="tabular-nums text-neutral-700">{row.valueAmount !== null ? formatRupiah(row.valueAmount) : "-"}</Td>}
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
