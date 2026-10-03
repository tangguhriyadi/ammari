import Link from "next/link";
import { formatRupiah } from "@ammari/ui/lib";
import { Badge, Card } from "@ammari/ui";
import type { listProducts } from "@/lib/products/queries";
import { ProductThumbnail } from "./product-thumbnail";

const CLOSURE_LABELS: Record<string, string> = {
  front_zip: "Resleting depan",
  back_zip: "Resleting belakang",
};

type Product = Awaited<ReturnType<typeof listProducts>>["rows"][number];

export function ProductList({ products }: { products: Product[] }) {
  if (products.length === 0) {
    return <p className="py-8 text-center text-base text-neutral-600">Tidak ada produk yang cocok.</p>;
  }

  return (
    <>
      <ul className="flex flex-col gap-3 md:hidden">
        {products.map((product) => (
          <li key={product.id}>
            <Link href={`/produk/${product.id}`}>
              <Card className="flex gap-3">
                <ProductThumbnail url={product.thumbnailUrl} className="size-16 shrink-0" />
                <div className="flex flex-1 flex-col gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-base font-semibold text-neutral-900">{product.name}</span>
                    <Badge variant={product.isActive ? "success" : "neutral"}>
                      {product.isActive ? "Aktif" : "Nonaktif"}
                    </Badge>
                  </div>
                  <span className="text-sm text-neutral-600">
                    {product.fabricName} · {CLOSURE_LABELS[product.closure] ?? product.closure}
                  </span>
                  <span className="text-sm text-neutral-600">
                    {formatRupiah(product.basePrice)} · {product.activeVariantCount} varian aktif
                  </span>
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto rounded-lg border border-neutral-200 md:block">
        <table className="w-full text-left text-base">
          <thead className="border-b border-neutral-200 bg-neutral-50 text-sm text-neutral-600">
            <tr>
              <th className="px-4 py-3 font-medium">
                <span className="sr-only">Thumbnail</span>
              </th>
              <th className="px-4 py-3 font-medium">Nama</th>
              <th className="px-4 py-3 font-medium">Bahan</th>
              <th className="px-4 py-3 font-medium">Model resleting</th>
              <th className="px-4 py-3 font-medium">Harga dasar</th>
              <th className="px-4 py-3 font-medium">Varian aktif</th>
              <th className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                <td className="px-4 py-3">
                  <ProductThumbnail url={product.thumbnailUrl} className="size-10" />
                </td>
                <td className="px-4 py-3">
                  <Link href={`/produk/${product.id}`} className="font-medium text-brand hover:underline">
                    {product.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-neutral-700">{product.fabricName}</td>
                <td className="px-4 py-3 text-neutral-700">{CLOSURE_LABELS[product.closure] ?? product.closure}</td>
                <td className="px-4 py-3 text-neutral-700 tabular-nums">{formatRupiah(product.basePrice)}</td>
                <td className="px-4 py-3 text-neutral-700 tabular-nums">{product.activeVariantCount}</td>
                <td className="px-4 py-3">
                  <Badge variant={product.isActive ? "success" : "neutral"}>
                    {product.isActive ? "Aktif" : "Nonaktif"}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
