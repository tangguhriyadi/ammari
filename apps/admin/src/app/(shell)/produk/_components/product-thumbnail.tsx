import { ProductImage } from "./product-image";

/** Used wherever a product's thumbnail is shown — the product list (mobile card + desktop
 * table) and the detail page header. */
export function ProductThumbnail({ url, className }: { url: string | null; className: string }) {
  return (
    <ProductImage
      src={url}
      alt=""
      sizes="(max-width: 640px) 25vw, 120px"
      className={`rounded-md object-cover ${className}`}
    />
  );
}
