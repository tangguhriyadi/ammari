import Link from "next/link";
import { formatRupiah } from "@ammari/ui/lib";
import { Badge, Card } from "@ammari/ui";
import type { listFabricsWithUsage } from "@/lib/products/fabric-queries";

const PRICE_UNIT_LABELS: Record<string, string> = { meter: "/m", yard: "/yard" };

type Fabric = Awaited<ReturnType<typeof listFabricsWithUsage>>["rows"][number];

function priceLabel(fabric: Fabric): string | null {
  if (fabric.priceAmount == null || fabric.priceUnit == null) return null;
  return `${formatRupiah(fabric.priceAmount)}${PRICE_UNIT_LABELS[fabric.priceUnit] ?? ""}`;
}

export function FabricList({ fabrics }: { fabrics: Fabric[] }) {
  if (fabrics.length === 0) {
    return <p className="py-8 text-center text-base text-neutral-600">Belum ada bahan.</p>;
  }

  return (
    <>
      {/* Phone: cards, not a wide table. */}
      <ul className="flex flex-col gap-3 md:hidden">
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
      </ul>

      {/* Desktop/tablet: a table is fine here. */}
      <div className="hidden overflow-x-auto rounded-lg border border-neutral-200 md:block">
        <table className="w-full text-left text-base">
          <thead className="border-b border-neutral-200 bg-neutral-50 text-sm text-neutral-600">
            <tr>
              <th className="px-4 py-3 font-medium">Nama</th>
              <th className="px-4 py-3 font-medium">Pemasok</th>
              <th className="px-4 py-3 font-medium">Komposisi</th>
              <th className="px-4 py-3 font-medium">Harga</th>
              <th className="px-4 py-3 font-medium">Dipakai</th>
            </tr>
          </thead>
          <tbody>
            {fabrics.map((fabric) => (
              <tr key={fabric.id} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                <td className="px-4 py-3">
                  <Link href={`/fabrics/${fabric.id}`} className="font-medium text-brand hover:underline">
                    {fabric.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-neutral-700">{fabric.supplier ?? "—"}</td>
                <td className="px-4 py-3 text-neutral-700">{fabric.composition ?? "—"}</td>
                <td className="px-4 py-3 text-neutral-700">{priceLabel(fabric) ?? "—"}</td>
                <td className="px-4 py-3 text-neutral-700">{fabric.productCount} produk</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
