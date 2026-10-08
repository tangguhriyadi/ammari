import Link from "next/link";
import { formatRupiah } from "@ammari/ui/lib";
import { Badge, Card, EmptyState, TableContainer, TableHead, Th, Tr, Td, CardList } from "@ammari/ui";
import type { listFabricsWithUsage } from "@/lib/products/fabric-queries";

const PRICE_UNIT_LABELS: Record<string, string> = { meter: "/m", yard: "/yard" };

type Fabric = Awaited<ReturnType<typeof listFabricsWithUsage>>["rows"][number];

function priceLabel(fabric: Fabric): string | null {
  if (fabric.priceAmount == null || fabric.priceUnit == null) return null;
  return `${formatRupiah(fabric.priceAmount)}${PRICE_UNIT_LABELS[fabric.priceUnit] ?? ""}`;
}

export function FabricList({ fabrics }: { fabrics: Fabric[] }) {
  if (fabrics.length === 0) {
    return <EmptyState title="Belum ada bahan" description="Tambah bahan untuk mulai mencatatnya." />;
  }

  return (
    <>
      <CardList>
        {fabrics.map((fabric) => (
          <li key={fabric.id}>
            <Link href={`/fabrics/${fabric.id}`}>
              <Card className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-base font-semibold text-neutral-900">{fabric.name}</span>
                  {fabric.productCount > 0 && <Badge variant="neutral">{fabric.productCount} produk</Badge>}
                </div>
                {fabric.supplier && <span className="text-sm text-neutral-600">{fabric.supplier}</span>}
                {fabric.composition && <span className="text-sm text-neutral-600">{fabric.composition}</span>}
                {priceLabel(fabric) && <span className="text-sm text-neutral-600">{priceLabel(fabric)}</span>}
              </Card>
            </Link>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Nama</Th>
          <Th>Pemasok</Th>
          <Th>Komposisi</Th>
          <Th>Harga</Th>
          <Th>Dipakai</Th>
        </TableHead>
        <tbody>
          {fabrics.map((fabric) => (
            <Tr key={fabric.id}>
              <Td>
                <Link href={`/fabrics/${fabric.id}`} className="font-medium text-brand hover:underline">
                  {fabric.name}
                </Link>
              </Td>
              <Td className="text-neutral-700">{fabric.supplier ?? "—"}</Td>
              <Td className="text-neutral-700">{fabric.composition ?? "—"}</Td>
              <Td className="text-neutral-700">{priceLabel(fabric) ?? "—"}</Td>
              <Td className="text-neutral-700">{fabric.productCount} produk</Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
