import Link from "next/link";
import type { StorefrontProductTile } from "@ammari/db/storefront";
import { formatPriceIdr } from "@/lib/format";
import { storageImageUrl } from "@/lib/storage/public-url";
import { ProductImage } from "./product-image";

/** The one tile component for both the homepage's product grid and the PDP's "Lengkapi
 * koleksimu" related products (docs/design/storefront.md §5 item 2, §6 item 10 — "same tile
 * component as the grid"). Image 2:3, name, colour (+ colour count when the tile doesn't pin one
 * specific colour), price. The whole tile is one link, `?color=` only when a colour is pinned. */
export function ProductTile({ tile, imagePriority = false }: { tile: StorefrontProductTile; imagePriority?: boolean }) {
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
      </div>
      <p className="text-xs text-ink">{tile.name}</p>
      {colorLabel && <p className="text-xs text-ink-muted">{colorLabel}</p>}
      <p className="text-[13px] font-medium text-ink">{formatPriceIdr(tile.basePrice)}</p>
    </Link>
  );
}
