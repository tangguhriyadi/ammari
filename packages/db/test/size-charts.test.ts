import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { fabrics, products, sizeChartRows, sizeCharts } from "../src/schema";
import { withRollback, type TestTx } from "./helpers";

async function insertFabricFixture(tx: TestTx) {
  const [fabric] = await tx.insert(fabrics).values({ name: "Katun Rayon" }).returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");
  return fabric;
}

async function insertSizeChart(tx: TestTx, name = "Gamis Reguler") {
  const [chart] = await tx.insert(sizeCharts).values({ name }).returning();
  if (!chart) throw new Error("failed to insert size chart fixture");
  return chart;
}

function rowValues(sizeChartId: string, overrides: Partial<typeof sizeChartRows.$inferInsert> = {}) {
  return {
    sizeChartId,
    size: "M" as const,
    bustCm: 100,
    lengthCm: 140,
    sleeveLengthCm: 55,
    heightRecommendationMinCm: 155,
    heightRecommendationMaxCm: 165,
    ...overrides,
  };
}

/** Same unwrapping other packages/db tests use — drizzle-orm wraps the driver error and puts the
 * real Postgres code on `.cause`. */
async function causeCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return (cause as { code?: string } | undefined)?.code;
  }
  throw new Error("expected promise to reject, but it resolved");
}

describe("size_charts", () => {
  test("a product can reference a size chart", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const chart = await insertSizeChart(tx);
      const [product] = await tx
        .insert(products)
        .values({
          name: "Gamis Test",
          code: `CODE${randomUUID().slice(0, 8).toUpperCase()}`,
          slug: `gamis-test-${randomUUID()}`,
          fabricId: fabric.id,
          closure: "front_zip",
          sizeMode: "sized",
          basePrice: 259_000,
          sizeChartId: chart.id,
        })
        .returning();
      expect(product?.sizeChartId).toBe(chart.id);
    });
  });

  test("deleting a size chart still referenced by a product fails (ON DELETE RESTRICT)", async () => {
    await withRollback(async (tx) => {
      const fabric = await insertFabricFixture(tx);
      const chart = await insertSizeChart(tx);
      await tx.insert(products).values({
        name: "Gamis Test",
        code: `CODE${randomUUID().slice(0, 8).toUpperCase()}`,
        slug: `gamis-test-${randomUUID()}`,
        fabricId: fabric.id,
        closure: "front_zip",
        sizeMode: "sized",
        basePrice: 259_000,
        sizeChartId: chart.id,
      });

      const code = await causeCode(tx.delete(sizeCharts).where(eq(sizeCharts.id, chart.id)));
      expect(code).toBe("23503"); // foreign_key_violation
    });
  });

  test("deleting an unreferenced size chart succeeds", async () => {
    await withRollback(async (tx) => {
      const chart = await insertSizeChart(tx);
      await expect(tx.delete(sizeCharts).where(eq(sizeCharts.id, chart.id))).resolves.not.toThrow();
    });
  });
});

describe("size_chart_rows", () => {
  test("accepts a valid row for every non-ALLSIZE size", async () => {
    await withRollback(async (tx) => {
      const chart = await insertSizeChart(tx);
      for (const size of ["XS", "S", "M", "L", "XL"] as const) {
        await expect(
          tx.insert(sizeChartRows).values(rowValues(chart.id, { size })),
        ).resolves.not.toThrow();
      }
    });
  });

  test("rejects ALLSIZE (size_chart_rows_size_not_allsize_check)", async () => {
    await withRollback(async (tx) => {
      const chart = await insertSizeChart(tx);
      const code = await causeCode(tx.insert(sizeChartRows).values(rowValues(chart.id, { size: "ALLSIZE" as never })));
      expect(code).toBe("23514");
    });
  });

  test("rejects an unknown size (size_chart_rows_size_check)", async () => {
    await withRollback(async (tx) => {
      const chart = await insertSizeChart(tx);
      const code = await causeCode(
        tx.insert(sizeChartRows).values(rowValues(chart.id, { size: "XXL" as never })),
      );
      expect(code).toBe("23514");
    });
  });

  test.each([
    ["bustCm", { bustCm: 0 }],
    ["lengthCm", { lengthCm: 0 }],
    ["sleeveLengthCm", { sleeveLengthCm: 0 }],
    ["heightRecommendationMinCm", { heightRecommendationMinCm: 0 }],
    ["heightRecommendationMaxCm", { heightRecommendationMaxCm: 0 }],
  ])("rejects %s <= 0", async (_label, overrides) => {
    await withRollback(async (tx) => {
      const chart = await insertSizeChart(tx);
      const code = await causeCode(tx.insert(sizeChartRows).values(rowValues(chart.id, overrides)));
      expect(code).toBe("23514");
    });
  });

  test("rejects a max height recommendation below the min (size_chart_rows_height_recommendation_range_check)", async () => {
    await withRollback(async (tx) => {
      const chart = await insertSizeChart(tx);
      const code = await causeCode(
        tx.insert(sizeChartRows).values(
          rowValues(chart.id, { heightRecommendationMinCm: 165, heightRecommendationMaxCm: 155 }),
        ),
      );
      expect(code).toBe("23514");
    });
  });

  test("allows an exact min = max (a single recommended height, no range)", async () => {
    await withRollback(async (tx) => {
      const chart = await insertSizeChart(tx);
      await expect(
        tx.insert(sizeChartRows).values(
          rowValues(chart.id, { heightRecommendationMinCm: 160, heightRecommendationMaxCm: 160 }),
        ),
      ).resolves.not.toThrow();
    });
  });

  test("rejects a duplicate (size_chart_id, size) pair", async () => {
    await withRollback(async (tx) => {
      const chart = await insertSizeChart(tx);
      await tx.insert(sizeChartRows).values(rowValues(chart.id));
      const code = await causeCode(tx.insert(sizeChartRows).values(rowValues(chart.id)));
      expect(code).toBe("23505"); // unique_violation
    });
  });

  test("the same size is allowed again on a DIFFERENT chart", async () => {
    await withRollback(async (tx) => {
      const chartA = await insertSizeChart(tx, "Gamis Reguler");
      const chartB = await insertSizeChart(tx, "Gamis Plus Size");
      await tx.insert(sizeChartRows).values(rowValues(chartA.id));
      await expect(tx.insert(sizeChartRows).values(rowValues(chartB.id))).resolves.not.toThrow();
    });
  });
});
