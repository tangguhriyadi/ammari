import Link from "next/link";
import { formatRupiah } from "@ammari/ui/lib";
import { Badge, Card, EmptyState, TableContainer, TableHead, Th, Tr, Td, CardList } from "@ammari/ui";
import type { listProducts } from "@/lib/products/queries";
import { ProductThumbnail } from "./product-thumbnail";

const CLOSURE_LABELS: Record<string, string> = {
  front_zip: "Resleting depan",
  back_zip: "Resleting belakang",
};

type Product = Awaited<ReturnType<typeof listProducts>>["rows"][number];

export function ProductList({ products }: { products: Product[] }) {
  if (products.length === 0) {
    return <EmptyState title="Tidak ada produk yang cocok" description="Coba ubah kata kunci pencarian." />;
  }

  return (
    <>
      <CardList>
        {products.map((product) => (
          <li key={product.id}>
            <Link href={`/products/${product.id}`}>
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
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>
            <span className="sr-only">Thumbnail</span>
          </Th>
          <Th>Nama</Th>
          <Th>Bahan</Th>
          <Th>Model resleting</Th>
          <Th>Harga dasar</Th>
          <Th>Varian aktif</Th>
          <Th>Status</Th>
        </TableHead>
        <tbody>
          {products.map((product) => (
            <Tr key={product.id}>
              <Td>
                <ProductThumbnail url={product.thumbnailUrl} className="size-10" />
              </Td>
              <Td>
                <Link href={`/products/${product.id}`} className="font-medium text-brand hover:underline">
                  {product.name}
                </Link>
              </Td>
              <Td className="text-neutral-700">{product.fabricName}</Td>
              <Td className="text-neutral-700">{CLOSURE_LABELS[product.closure] ?? product.closure}</Td>
              <Td className="text-neutral-700 tabular-nums">{formatRupiah(product.basePrice)}</Td>
              <Td className="text-neutral-700 tabular-nums">{product.activeVariantCount}</Td>
              <Td>
                <Badge variant={product.isActive ? "success" : "neutral"}>
                  {product.isActive ? "Aktif" : "Nonaktif"}
                </Badge>
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
