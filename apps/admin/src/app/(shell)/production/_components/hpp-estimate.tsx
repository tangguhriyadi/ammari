"use client";

import { formatRupiah } from "@ammari/ui/lib";
import { allocateBatchHpp } from "@/lib/production/batch-hpp";
import { previewLineTotal } from "@/lib/production/line-total-preview";
import { scopedLinesWithoutProduct, type BatchProductPcsOption, type ExtraCostLineState } from "./extra-cost-lines";

/** The draft's live, non-binding HPP per product: shared cost (the fabric estimate plus every
 * "Semua produk" line) spread over every pcs, plus each product's own scoped lines spread over
 * its own pcs. Accessories are not estimated here; posting computes the final value. Only
 * rendered by the caller for a finance.view_profit session, like the rest of the cost section. */
export function HppEstimate({
  estimatedFabricCost,
  lines,
  batchProducts,
}: {
  estimatedFabricCost: number | null;
  lines: readonly ExtraCostLineState[];
  batchProducts: readonly BatchProductPcsOption[];
}) {
  if (batchProducts.length === 0) return null;
  // A line whose product left the batch has its own message on the line; no estimate until fixed.
  if (scopedLinesWithoutProduct(lines, batchProducts).length > 0) {
    return (
      <p className="text-sm text-neutral-600" data-testid="hpp-estimate">
        Estimasi HPP per produk ditunda: ada biaya yang produknya tidak punya SKU di batch ini.
      </p>
    );
  }

  const totalPcs = batchProducts.reduce((sum, product) => sum + product.pcs, 0);
  const pcsByProduct = new Map(batchProducts.map((product) => [product.productId, product.pcs]));
  const costLines = lines.flatMap((line) => {
    const unitPrice = Number.parseInt(line.unitPrice, 10);
    if (!Number.isFinite(unitPrice)) return [];
    const productId = line.productId === "" ? null : line.productId;
    const quantity = line.costType === "fixed" ? 1 : productId === null ? totalPcs : (pcsByProduct.get(productId) ?? 0);
    return [{ productId, total: previewLineTotal(quantity, unitPrice) }];
  });
  const allocation = allocateBatchHpp({
    materialCost: estimatedFabricCost ?? 0,
    costLines,
    products: batchProducts.map(({ productId, pcs }) => ({ productId, pcs })),
  });
  const nameById = new Map(batchProducts.map((product) => [product.productId, product.productName]));
  const sharedPerPcs = allocation.sharedTotal / allocation.totalPcs;

  return (
    <div className="flex flex-col gap-2" data-testid="hpp-estimate">
      <span className="text-sm font-medium text-neutral-900">Estimasi HPP per produk</span>
      <ul className="flex flex-col gap-2">
        {allocation.products.map((product) => (
          <li
            key={product.productId}
            data-testid="hpp-estimate-row"
            className="flex flex-col gap-1 rounded-lg border border-neutral-200 p-3 text-sm text-neutral-700"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-neutral-900">
                {nameById.get(product.productId)} <span className="font-normal text-neutral-600">({product.pcs} pcs)</span>
              </span>
              <span className="font-semibold text-neutral-900 tabular-nums" data-testid="hpp-estimate-value">
                {formatRupiah(product.unitCostAmount)}/pcs
              </span>
            </div>
            <span className="tabular-nums">Biaya bersama {formatRupiah(Math.round(sharedPerPcs))}/pcs</span>
            {product.scopedTotal > 0 && (
              <span className="tabular-nums">
                Biaya khusus produk {formatRupiah(Math.round(product.scopedTotal / product.pcs))}/pcs
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-sm text-neutral-600">
        {estimatedFabricCost === null ? "Biaya bahan belum bisa diestimasi dan belum dihitung. " : ""}
        Rincian per pcs dibulatkan; HPP dibulatkan ke atas. Belum termasuk aksesoris. Nilai final dihitung ulang saat posting.
      </p>
    </div>
  );
}
