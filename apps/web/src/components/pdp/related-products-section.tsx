import type { PricedProductTile } from "@/lib/content/storefront-price";
import { ProductTile } from "@/components/product-tile";

/** docs/design/storefront.md §6 item 10 — "Lengkapi koleksimu", same tile component as the
 * homepage grid. Renders nothing if there's simply no other published product yet. */
export function RelatedProductsSection({ products }: { products: PricedProductTile[] }) {
  if (products.length === 0) return null;

  return (
    <section className="flex flex-col gap-4 py-8">
      <h2 className="font-serif text-2xl font-normal text-ink">Lengkapi koleksimu</h2>
      <div className="grid grid-cols-2 gap-x-[2px] gap-y-5">
        {products.map((product) => (
          <ProductTile key={`${product.productId}:${product.fabricColorId ?? ""}`} tile={product} />
        ))}
      </div>
    </section>
  );
}
