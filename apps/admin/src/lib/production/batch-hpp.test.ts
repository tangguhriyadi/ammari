import { describe, expect, test } from "vitest";
import { allocateBatchHpp, costLineQuantity } from "./batch-hpp";

const HAURA = "haura";
const CYRA = "cyra";

describe("allocateBatchHpp", () => {
  test("Haura 10 pcs sewn at 39k and Cyra 8 pcs at 37k share the fabric by pcs and keep their own sewing cost", () => {
    const result = allocateBatchHpp({
      materialCost: 1_800_000, // fabric: 100_000 per pcs over 18 pcs
      costLines: [
        { productId: HAURA, total: 10 * 39_000 },
        { productId: CYRA, total: 8 * 37_000 },
      ],
      products: [
        { productId: HAURA, pcs: 10 },
        { productId: CYRA, pcs: 8 },
      ],
    });
    expect(result.totalPcs).toBe(18);
    expect(result.sharedTotal).toBe(1_800_000);
    expect(result.products).toEqual([
      { productId: HAURA, pcs: 10, scopedTotal: 390_000, unitCostAmount: 139_000 },
      { productId: CYRA, pcs: 8, scopedTotal: 296_000, unitCostAmount: 137_000 },
    ]);
  });

  test("mixes scoped lines with batch-wide ones: batch-wide lines spread over every pcs", () => {
    const result = allocateBatchHpp({
      materialCost: 1_000_000,
      costLines: [
        { productId: HAURA, total: 10 * 39_000 },
        { productId: CYRA, total: 8 * 37_000 },
        { productId: null, total: 18 * 2_000 }, // packing for every pcs
        { productId: null, total: 54_000 }, // fixed transport for the batch
      ],
      products: [
        { productId: HAURA, pcs: 10 },
        { productId: CYRA, pcs: 8 },
      ],
    });
    // shared = 1_000_000 + 36_000 + 54_000 = 1_090_000; / 18 = 60_555.55...
    expect(result.sharedTotal).toBe(1_090_000);
    // Haura: 60_555.55... + 39_000 = 99_555.55... -> 99_556
    // Cyra:  60_555.55... + 37_000 = 97_555.55... -> 97_556
    expect(result.products.map((p) => p.unitCostAmount)).toEqual([99_556, 97_556]);
  });

  test("a fixed scoped line is spread over its own product's pcs only", () => {
    const result = allocateBatchHpp({
      materialCost: 900_000,
      costLines: [{ productId: CYRA, total: 80_000 }], // e.g. a pattern fee for Cyra only
      products: [
        { productId: HAURA, pcs: 10 },
        { productId: CYRA, pcs: 8 },
      ],
    });
    // shared 900_000 / 18 = 50_000; Cyra + 80_000 / 8 = 10_000.
    expect(result.products.map((p) => p.unitCostAmount)).toEqual([50_000, 60_000]);
  });

  test("without scoped lines every product gets ceil(total / pcs), the pre-scope behaviour", () => {
    const result = allocateBatchHpp({
      materialCost: 1_000_000,
      costLines: [{ productId: null, total: 0 }],
      products: [
        { productId: HAURA, pcs: 2 },
        { productId: CYRA, pcs: 1 },
      ],
    });
    expect(result.products.map((p) => p.unitCostAmount)).toEqual([333_334, 333_334]);
  });

  test("rounds up exactly, without float drift", () => {
    const result = allocateBatchHpp({
      materialCost: 10,
      costLines: [{ productId: HAURA, total: 1 }],
      products: [
        { productId: HAURA, pcs: 3 },
        { productId: CYRA, pcs: 3 },
      ],
    });
    // shared 10/6 = 1.67; Haura + 1/3 = 2 exactly -> 2; Cyra 1.67 -> 2.
    expect(result.products.map((p) => p.unitCostAmount)).toEqual([2, 2]);
  });

  test("rejects a scoped line whose product has no pcs in the batch", () => {
    expect(() =>
      allocateBatchHpp({
        materialCost: 0,
        costLines: [{ productId: CYRA, total: 100 }],
        products: [
          { productId: HAURA, pcs: 10 },
          { productId: CYRA, pcs: 0 },
        ],
      }),
    ).toThrow(/no pcs/);
  });

  test("rejects a batch with no pcs", () => {
    expect(() => allocateBatchHpp({ materialCost: 0, costLines: [], products: [] })).toThrow(/no pcs/);
  });
});

describe("costLineQuantity", () => {
  const pcs = new Map([
    [HAURA, 10],
    [CYRA, 8],
  ]);
  test("variable batch-wide line multiplies the whole batch", () => {
    expect(costLineQuantity({ costType: "variable", productId: null }, pcs, 18)).toBe(18);
  });
  test("variable scoped line multiplies only its product's pcs", () => {
    expect(costLineQuantity({ costType: "variable", productId: HAURA }, pcs, 18)).toBe(10);
    expect(costLineQuantity({ costType: "variable", productId: CYRA }, pcs, 18)).toBe(8);
  });
  test("a product with no pcs gives 0", () => {
    expect(costLineQuantity({ costType: "variable", productId: "other" }, pcs, 18)).toBe(0);
  });
  test("fixed lines are always 1", () => {
    expect(costLineQuantity({ costType: "fixed", productId: HAURA }, pcs, 18)).toBe(1);
    expect(costLineQuantity({ costType: "fixed", productId: null }, pcs, 18)).toBe(1);
  });
});
