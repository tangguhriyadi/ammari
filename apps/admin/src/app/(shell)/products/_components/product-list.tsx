import Link from "next/link";
import { formatRupiah } from "@ammari/ui/lib";
import { Badge, Card, EmptyState, TableContainer, TableHead, Th, Tr, Td, CardList } from "@ammari/ui";
import { PRODUCT_HIGHLIGHTS } from "@ammari/db/highlights";
import type { listProducts } from "@/lib/products/queries";
import { DISCOUNT_STATUS_BADGE_VARIANTS, DISCOUNT_STATUS_LABELS } from "@/lib/products/discount";
import { ProductThumbnail } from "./product-thumbnail";

const CLOSURE_LABELS: Record<string, string> = {
  front_zip: "Resleting depan",
  back_zip: "Resleting belakang",
};

type Product = Awaited<ReturnType<typeof listProducts>>["rows"][number];

/** Read-only label list, in the one canonical order — iterates PRODUCT_HIGHLIGHTS (not the
 * product's own stored array) so display order never depends on storage order. */
/** The price, struck through next to the discounted one while a discount is active. */
function ProductPrice({ product }: { product: Product }) {
  if (product.effectivePrice === product.basePrice) return <>{formatRupiah(product.basePrice)}</>;
  return (
    <>
      <s className="text-neutral-500">{formatRupiah(product.basePrice)}</s> <span className="font-medium text-neutral-900">{formatRupiah(product.effectivePrice)}</span>
    </>
  );
}

/** The discount chip (docs/plans/product-discount.md §9), only for products with a sale price
 * stored. "Diskon" in front, so its Aktif/Nonaktif can't be read as the product's own status. */
function DiscountChip({ product }: { product: Product }) {
  if (product.discountStatus === null) return null;
  return (
    <span className="inline-flex items-center gap-1 text-sm text-neutral-600" data-testid="product-discount-chip">
      Diskon
      <Badge variant={DISCOUNT_STATUS_BADGE_VARIANTS[product.discountStatus]}>{DISCOUNT_STATUS_LABELS[product.discountStatus]}</Badge>
    </span>
  );
}

function highlightLabels(keys: readonly string[]): string[] {
  return PRODUCT_HIGHLIGHTS.filter((h) => keys.includes(h.key)).map((h) => h.label);
}

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
                    <ProductPrice product={product} /> · {product.activeVariantCount} varian aktif
                  </span>
                  <DiscountChip product={product} />
                  {(product.missingPhotos || product.missingShippingWeight) && (
                    <div className="flex flex-wrap gap-1">
                      {product.missingPhotos && <Badge variant="warning">Belum ada foto</Badge>}
                      {product.missingShippingWeight && <Badge variant="warning">Berat kirim belum diisi</Badge>}
                    </div>
                  )}
                  {product.highlights.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {highlightLabels(product.highlights).map((label) => (
                        <Badge key={label}>{label}</Badge>
                      ))}
                    </div>
                  )}
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
          <Th>Harga</Th>
          <Th>Varian aktif</Th>
          <Th>Keunggulan</Th>
          <Th>Status</Th>
        </TableHead>
        <tbody>
          {products.map((product) => (
            <Tr key={product.id}>
              <Td>
                <ProductThumbnail url={product.thumbnailUrl} className="size-10" />
              </Td>
              <Td>
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/products/${product.id}`} className="font-medium text-brand hover:underline">
                    {product.name}
                  </Link>
                  {product.missingPhotos && <Badge variant="warning">Belum ada foto</Badge>}
                  {product.missingShippingWeight && <Badge variant="warning">Berat kirim belum diisi</Badge>}
                </div>
              </Td>
              <Td className="text-neutral-700">{product.fabricName}</Td>
              <Td className="text-neutral-700">{CLOSURE_LABELS[product.closure] ?? product.closure}</Td>
              <Td className="text-neutral-700 tabular-nums">
                <div className="flex flex-col items-start gap-1">
                  <span>
                    <ProductPrice product={product} />
                  </span>
                  <DiscountChip product={product} />
                </div>
              </Td>
              <Td className="text-neutral-700 tabular-nums">{product.activeVariantCount}</Td>
              <Td>
                {product.highlights.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {highlightLabels(product.highlights).map((label) => (
                      <Badge key={label}>{label}</Badge>
                    ))}
                  </div>
                )}
              </Td>
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
