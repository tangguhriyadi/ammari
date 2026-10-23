import Link from "next/link";
import type { PricedProductTile } from "@/lib/content/storefront-price";
import { storageImageUrl } from "@/lib/storage/public-url";
import { ProductImage } from "./product-image";
import { ProductPrice } from "./product-price";

/** The one tile component for both the homepage's product grid and the PDP's "Lengkapi
 * koleksimu" related products (docs/design/storefront.md §5 item 2, §6 item 10 — "same tile
 * component as the grid"). Image 2:3, name, colour (+ colour count when the tile doesn't pin one
 * specific colour), price. The whole tile is one link, `?color=` only when a colour is pinned.
 *
 * A discounted tile gets the `N% OFF` badge (docs/plans/product-discount.md §9): bold 19px, the
 * smallest size that counts as WCAG large text, since white on the discount red is only 3.89:1.
 * A sold-out tile shows only "Sold out", never the badge (owner answer 7); its prices still show
 * struck + red. */
export function ProductTile({ tile, imagePriority = false }: { tile: PricedProductTile; imagePriority?: boolean }) {
  const href = tile.fabricColorId ? `/products/${tile.slug}?color=${tile.fabricColorId}` : `/products/${tile.slug}`;
  const colorLabel = tile.fabricColorId ? tile.colorName : tile.colorCount > 1 ? `${tile.colorName} · ${tile.colorCount} warna` : tile.colorName;

  return (
    <Link href={href} className="group flex flex-col gap-1.5">
      <div className="relative aspect-[2/3] w-full overflow-hidden bg-image-bg">
        {/* tile.image is already the pinned colour's photo, else the product's first photo
            (getStorefrontProductTiles); null only when the product has no photo at all. */}
        <ProductImage
          src={tile.image ? storageImageUrl(tile.image.storageKey, 800) : null}
          alt={tile.image?.altText ?? tile.name}
          placeholderAlt=""
          placeholderSize={800}
          priority={imagePriority}
          sizes="(max-width: 768px) 50vw, (max-width: 1280px) 33vw, 25vw"
          className="object-cover transition-transform duration-200 group-hover:scale-[1.02]"
        />
        {tile.soldOut ? (
          <span className="absolute top-2 left-2 bg-bg px-2 py-1 text-[11px] text-ink-muted">Sold out</span>
        ) : (
          tile.price.percentOff !== null && (
            <span className="absolute top-2 left-2 bg-discount px-2 py-1 text-[19px] leading-none font-bold text-white" data-testid="discount-badge">
              {tile.price.percentOff}% OFF
            </span>
          )
        )}
      </div>
      <p className="text-xs text-ink">{tile.name}</p>
      {colorLabel && <p className="text-xs text-ink-muted">{colorLabel}</p>}
      <ProductPrice price={tile.price} className="text-[13px] font-medium" />
    </Link>
  );
}
