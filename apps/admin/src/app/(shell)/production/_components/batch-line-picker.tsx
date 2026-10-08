"use client";

import { useMemo } from "react";
import { ColorSwatch, Input, Label } from "@ammari/ui";
import type { EligibleSkuRow } from "@/lib/production/queries";

export interface BatchLinePickerProps {
  eligibleSkus: EligibleSkuRow[];
  /** sku -> qty, 0/absent = not included in the batch. */
  quantities: Record<string, number>;
  onQtyChange: (sku: string, qty: number) => void;
  /** `null` while no yards have been entered yet — the yard/pcs hint simply doesn't render. */
  fabricYards: number | null;
}

interface ColorGroup {
  colorId: string;
  colorName: string;
  colorHex: string | null;
  variants: EligibleSkuRow[];
}

interface ProductGroup {
  productId: string;
  productName: string;
  colors: ColorGroup[];
}

function groupByProductThenColor(rows: EligibleSkuRow[]): ProductGroup[] {
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

/** SKU picker for a production batch's output lines, grouped product -> color -> size for a
 * phone-friendly flow (the spec's own wording) — one qty input per SKU, 0/empty simply excluded
 * from the submitted line list. */
export function BatchLinePicker({ eligibleSkus, quantities, onQtyChange, fabricYards }: BatchLinePickerProps) {
  const groups = useMemo(() => groupByProductThenColor(eligibleSkus), [eligibleSkus]);
  const totalPcs = useMemo(() => Object.values(quantities).reduce((sum, qty) => sum + qty, 0), [quantities]);
  // A non-binding display hint only — never stored, never affects validation. `null` whenever
  // there's nothing meaningful to divide (no yards entered yet, or no quantities staged yet).
  const yardPerPcs = fabricYards !== null && totalPcs > 0 ? fabricYards / totalPcs : null;

  if (eligibleSkus.length === 0) {
    return <p className="text-base text-neutral-600">Bahan ini belum punya varian produk yang aktif.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {/* h2, not h1 — this sits directly under the page's own h1 (PageHeader), with each
          product's name below it correctly nested one level deeper as h3. */}
      <h2 className="text-lg font-semibold text-neutral-900">Hasil produksi</h2>
      {yardPerPcs !== null && (
        <p className="text-sm text-neutral-600">{yardPerPcs.toFixed(2)} yard/pcs dari jumlah saat ini.</p>
      )}
      {groups.map((product) => (
        <div key={product.productId} className="flex flex-col gap-3">
          <h3 className="text-base font-semibold text-neutral-900">{product.productName}</h3>
          {product.colors.map((color) => (
            <div key={color.colorId} className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3">
              <div className="flex items-center gap-2">
                <ColorSwatch hex={color.colorHex} />
                <span className="text-sm font-medium text-neutral-900">{color.colorName}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {color.variants.map((variant) => (
                  <div key={variant.sku}>
                    <Label htmlFor={`qty-${variant.sku}`}>{variant.size === "ALLSIZE" ? "All Size" : variant.size}</Label>
                    <Input
                      id={`qty-${variant.sku}`}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      value={quantities[variant.sku] ?? ""}
                      onChange={(event) => {
                        const parsed = Number.parseInt(event.target.value, 10);
                        onQtyChange(variant.sku, Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
                      }}
                      placeholder="0"
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
