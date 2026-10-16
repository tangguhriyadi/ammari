import type { ResolvedProductGrid } from "@/lib/content/homepage-resolve";
import { Container } from "@/components/container";
import { ProductTile } from "@/components/product-tile";

/** docs/design/storefront.md §5 item 2 — H2 + count, 2/3/4-column responsive grid. `id="koleksi"`
 * is the hero's anchor-CTA scroll target. */
export function ProductGridSection({ grid }: { grid: ResolvedProductGrid }) {
  return (
    <section id="koleksi" className="py-10 md:py-14">
      <Container>
        <div className="mb-6 flex items-baseline justify-between gap-4">
          <h2 className="font-serif text-2xl font-normal text-ink">{grid.title}</h2>
          <p className="text-sm text-ink-muted">{grid.tiles.length} produk</p>
        </div>
        <div className="grid grid-cols-2 gap-x-[2px] gap-y-5 md:grid-cols-3 xl:grid-cols-4">
          {grid.tiles.map((tile, index) => (
            <ProductTile key={`${tile.productId}:${tile.fabricColorId ?? ""}`} tile={tile} imagePriority={index < 2} />
          ))}
        </div>
      </Container>
    </section>
  );
}
