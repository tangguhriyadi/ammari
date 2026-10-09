"use client";

import { useMemo } from "react";
import { ColorSwatch, Input, Label } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import type { OrderableVariantRow } from "@/lib/orders/queries";

export interface OrderLine {
  qty: number;
  /** Text, not a parsed number — same "free text, parsed server-side via moneyString" idiom
   * PurchaseForm's own amount field uses, so the input can hold "269.000" while typing. */
  unitPrice: string;
}

export interface OrderItemPickerProps {
  variants: OrderableVariantRow[];
  /** sku -> line. A SKU absent from this map, or present with qty 0, is not part of the order. */
  lines: Record<string, OrderLine>;
  onLineChange: (sku: string, line: OrderLine) => void;
}

interface ColorGroup {
  colorId: string;
  colorName: string;
  colorHex: string | null;
  variants: OrderableVariantRow[];
}

interface ProductGroup {
  productId: string;
  productName: string;
  colors: ColorGroup[];
}

function groupByProductThenColor(rows: OrderableVariantRow[]): ProductGroup[] {
  const products = new Map<string, ProductGroup>();
  for (const row of rows) {
    let product = products.get(row.productId);
    if (!product) {
      product = { productId: row.productId, productName: row.productName, colors: [] };
      products.set(row.productId, product);
    }
    let color = product.colors.find((c) => c.colorId === row.colorId);
    if (!color) {
      color = { colorId: row.colorId, colorName: row.colorName, colorHex: row.colorHex, variants: [] };
      product.colors.push(color);
    }
    color.variants.push(row);
  }
  return Array.from(products.values());
}

/** SKU picker for a manual order's items, grouped product -> color -> size (same phone-friendly
 * division of labor as production's BatchLinePicker) — but with BOTH a qty and a unit price
 * input per SKU, since a sale's price can be negotiated per order, unlike a production batch's
 * fixed output qty. Price starts prefilled from the variant's effective price the moment qty
 * first becomes positive, and is freely editable after that. */
export function OrderItemPicker({ variants, lines, onLineChange }: OrderItemPickerProps) {
  const groups = useMemo(() => groupByProductThenColor(variants), [variants]);
  const variantBySku = useMemo(() => new Map(variants.map((v) => [v.sku, v])), [variants]);

  const subtotal = useMemo(
    () =>
      Object.values(lines).reduce((sum, line) => {
        if (line.qty <= 0) return sum;
        const price = Number.parseInt(line.unitPrice.replace(/\D/g, ""), 10);
        return sum + line.qty * (Number.isFinite(price) ? price : 0);
      }, 0),
    [lines],
  );

  function handleQtyChange(sku: string, qty: number) {
    const existing = lines[sku];
    const defaultPrice = variantBySku.get(sku)?.effectivePrice ?? 0;
    onLineChange(sku, { qty, unitPrice: existing?.unitPrice || String(defaultPrice) });
  }

  function handlePriceChange(sku: string, unitPrice: string) {
    const existing = lines[sku] ?? { qty: 0, unitPrice: "" };
    onLineChange(sku, { ...existing, unitPrice });
  }

  if (variants.length === 0) {
    return <p className="text-base text-neutral-600">Belum ada produk aktif untuk dipesan.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold text-neutral-900">Item pesanan</h2>
      {groups.map((product) => (
        <div key={product.productId} className="flex flex-col gap-3">
          <h3 className="text-base font-semibold text-neutral-900">{product.productName}</h3>
          {product.colors.map((color) => (
            <div key={color.colorId} className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3">
              <div className="flex items-center gap-2">
                <ColorSwatch hex={color.colorHex} />
                <span className="text-sm font-medium text-neutral-900">{color.colorName}</span>
              </div>
              <div className="flex flex-col gap-3">
                {color.variants.map((variant) => {
                  const line = lines[variant.sku];
                  const active = (line?.qty ?? 0) > 0;
                  return (
                    <div key={variant.sku} className="grid grid-cols-[auto_1fr_1fr] items-end gap-3">
                      <div>
                        <Label htmlFor={`qty-${variant.sku}`}>{variant.size === "ALLSIZE" ? "All Size" : variant.size}</Label>
                        <Input
                          id={`qty-${variant.sku}`}
                          type="number"
                          inputMode="numeric"
                          min={0}
                          step={1}
                          value={line?.qty ?? ""}
                          onChange={(event) => {
                            const parsed = Number.parseInt(event.target.value, 10);
                            handleQtyChange(variant.sku, Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
                          }}
                          placeholder="0"
                          className="w-20"
                        />
                      </div>
                      <div>
                        <Label htmlFor={`price-${variant.sku}`}>Harga satuan</Label>
                        <Input
                          id={`price-${variant.sku}`}
                          inputMode="numeric"
                          disabled={!active}
                          value={line?.unitPrice ?? String(variant.effectivePrice)}
                          onChange={(event) => handlePriceChange(variant.sku, event.target.value)}
                        />
                      </div>
                      {active && line && (
                        <p className="text-sm text-neutral-600 tabular-nums">
                          = {formatRupiah(line.qty * (Number.parseInt(line.unitPrice.replace(/\D/g, ""), 10) || 0))}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ))}
      <p className="text-base font-semibold text-neutral-900">Subtotal: {formatRupiah(subtotal)}</p>
    </div>
  );
}
