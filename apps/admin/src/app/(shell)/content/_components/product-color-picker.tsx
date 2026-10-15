"use client";

import { Label, Select } from "@ammari/ui";
import type { PublishableProductOption } from "@/lib/content/homepage";

export interface ProductColorValue {
  productId: string;
  fabricColorId: string | null;
}

/** Product + optional color picker shared by Hero's "tujuan produk" CTA, Feature Block's linked
 * product, and each Product Grid tile — only offers products currently published on the
 * storefront (`listPublishableProducts`, @/lib/content/homepage), per
 * docs/plans/storefront-cms.md's "only offers products that are published on the storefront"
 * requirement. Plain `<select>`s, not a search-as-you-type combobox — no such component exists
 * yet elsewhere in admin (checked production/orders' own "new" flows first, per the plan's own
 * note to look before building one), and native selects stay keyboard/screen-reader-accessible
 * and type-ahead-searchable for free at this catalog's size. */
export function ProductColorPicker({
  products,
  value,
  onChange,
  idPrefix,
  productLabel = "Produk",
  colorLabel = "Warna",
  error,
}: {
  products: PublishableProductOption[];
  value: ProductColorValue | null;
  onChange: (value: ProductColorValue | null) => void;
  idPrefix: string;
  productLabel?: string;
  colorLabel?: string;
  error?: string;
}) {
  const selectedProduct = products.find((product) => product.id === value?.productId) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-product`}>{productLabel}</Label>
        <Select
          id={`${idPrefix}-product`}
          value={value?.productId ?? ""}
          onChange={(event) => {
            const productId = event.target.value;
            onChange(productId ? { productId, fabricColorId: null } : null);
          }}
          error={error}
        >
          <option value="">Belum dipilih</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </Select>
        {products.length === 0 && (
          <p className="text-sm text-neutral-600">Belum ada produk yang tayang di toko online.</p>
        )}
      </div>

      {selectedProduct && selectedProduct.colors.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-color`}>{colorLabel}</Label>
          <Select
            id={`${idPrefix}-color`}
            value={value?.fabricColorId ?? ""}
            onChange={(event) =>
              onChange({ productId: selectedProduct.id, fabricColorId: event.target.value || null })
            }
          >
            <option value="">Semua warna</option>
            {selectedProduct.colors.map((color) => (
              <option key={color.id} value={color.id}>
                {color.name}
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
  );
}
