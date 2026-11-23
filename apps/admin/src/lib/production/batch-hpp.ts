import type { CostComponentType } from "@ammari/db/schema";

// HPP per product for a production batch whose "Biaya lain" lines can be scoped to one product
// (migration 0047, production_batch_costs.product_id). Pure, no database and no server-only
// import: postBatch uses it to write unit_cost_amount, the draft form uses it for its live
// estimate, and the posted batch's cost section uses it for the breakdown.
//
// Rules:
//  - Shared cost (fabric, accessories, every line with productId = null) is spread over the
//    WHOLE batch's pcs, exactly as before scoped lines existed.
//  - A scoped line's total is spread over ITS product's pcs only.
//  - HPP per pcs of a product = ceil(shared / totalPcs + scoped[product] / productPcs), computed
//    exactly in integers (never floats), rounded UP like calculateUnitCost so the recorded cost
//    never understates spend. With no scoped lines this is ceil(shared / totalPcs), the same
//    value every line got before.

export interface BatchProductPcs {
  productId: string;
  pcs: number;
}

export interface HppCostLine {
  /** `null` = "Semua produk" (batch-wide). */
  productId: string | null;
  total: number;
}

export interface ProductHpp {
  productId: string;
  pcs: number;
  /** Σ totals of the lines scoped to this product. */
  scopedTotal: number;
  /** HPP per pcs (rupiah, rounded up). */
  unitCostAmount: number;
}

export interface BatchHppAllocation {
  totalPcs: number;
  /** Fabric + accessories + every batch-wide line. */
  sharedTotal: number;
  products: ProductHpp[];
}

/** Rounded-up integer division of two non-negative bigints (b > 0). */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Products with pcs = 0 are ignored for allocation; a scoped line naming a product with no pcs
 * in the batch throws (callers validate first and give the staff a message). */
export function allocateBatchHpp(params: {
  /** Fabric + accessory cost (everything not on a cost line). */
  materialCost: number;
  costLines: readonly HppCostLine[];
  products: readonly BatchProductPcs[];
}): BatchHppAllocation {
  const products = params.products.filter((product) => product.pcs > 0);
  const totalPcs = products.reduce((sum, product) => sum + product.pcs, 0);
  if (totalPcs <= 0) throw new Error("allocateBatchHpp: batch has no pcs");

  const scopedByProduct = new Map<string, number>();
  let sharedTotal = params.materialCost;
  for (const line of params.costLines) {
    if (line.productId === null) {
      sharedTotal += line.total;
      continue;
    }
    if (!products.some((product) => product.productId === line.productId)) {
      throw new Error(`allocateBatchHpp: scoped line's product ${line.productId} has no pcs in this batch`);
    }
    scopedByProduct.set(line.productId, (scopedByProduct.get(line.productId) ?? 0) + line.total);
  }

  const shared = BigInt(sharedTotal);
  const total = BigInt(totalPcs);
  return {
    totalPcs,
    sharedTotal,
    products: products.map((product) => {
      const scopedTotal = scopedByProduct.get(product.productId) ?? 0;
      const pcs = BigInt(product.pcs);
      // shared/total + scoped/pcs = (shared*pcs + scoped*total) / (total*pcs)
      const unitCost = ceilDiv(shared * pcs + BigInt(scopedTotal) * total, total * pcs);
      return { productId: product.productId, pcs: product.pcs, scopedTotal, unitCostAmount: Number(unitCost) };
    }),
  };
}

/** A cost line's quantity, never typed by hand: a variable line multiplies the pcs it applies to
 * (its product's pcs when scoped, else the whole batch's), a fixed line is always 1. */
export function costLineQuantity(
  line: { costType: CostComponentType; productId: string | null },
  pcsByProduct: ReadonlyMap<string, number>,
  totalPcs: number,
): number {
  if (line.costType === "fixed") return 1;
  return line.productId === null ? totalPcs : (pcsByProduct.get(line.productId) ?? 0);
}
