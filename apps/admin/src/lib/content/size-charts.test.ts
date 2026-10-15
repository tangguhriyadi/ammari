import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback } from "@ammari/db/test-utils";
import { insertProductVariant } from "@ammari/db/test-fixtures";
import { products, sizeCharts, sizeChartRows } from "@ammari/db/schema";
import { CUTTING_SIZES, type CuttingSize } from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { createSizeChart, deleteSizeChart, getSizeChartDetail, listSizeCharts, updateSizeChart, type SizeChartRowInput } from "./size-charts";

const ACTOR_ID = null;

function fullRows(overrides: Partial<Record<CuttingSize, Partial<SizeChartRowInput>>> = {}): SizeChartRowInput[] {
  return CUTTING_SIZES.map((size, index) => ({
    size,
    bustCm: 90 + index * 2,
    lengthCm: 130 + index,
    sleeveLengthCm: 55 + index,
    heightRecommendationMinCm: 150 + index,
    heightRecommendationMaxCm: 160 + index,
    ...overrides[size],
  }));
}

describe("createSizeChart / updateSizeChart / getSizeChartDetail", () => {
  test("round-trips rows in CUTTING_SIZES' own canonical order, regardless of input order", async () => {
    await withRollback(async (tx) => {
      const rows = [...fullRows()].reverse(); // input in reverse (XL first, XS last)
      const chart = await createSizeChart({ name: "Gamis Reguler", rows }, ACTOR_ID, tx);

      const detail = await getSizeChartDetail(chart.id, tx);
      expect(detail?.rows.map((row) => row.size)).toEqual([...CUTTING_SIZES]);
      expect(detail?.name).toBe("Gamis Reguler");
    });
  });

  test("rejects a submission missing one of the 5 fixed sizes", async () => {
    await withRollback(async (tx) => {
      const rows = fullRows().filter((row) => row.size !== "M");
      await expect(createSizeChart({ name: "Chart Tidak Lengkap", rows }, ACTOR_ID, tx)).rejects.toThrow(ActionError);
    });
  });

  test("rejects a row whose height max is below its own min", async () => {
    await withRollback(async (tx) => {
      const rows = fullRows({ M: { heightRecommendationMinCm: 170, heightRecommendationMaxCm: 160 } });
      await expect(createSizeChart({ name: "Chart Tinggi Salah", rows }, ACTOR_ID, tx)).rejects.toThrow(FieldError);
    });
  });

  test("the bust_cm > 0 DB CHECK still rejects a zero/negative value even if it ever bypassed app validation", async () => {
    await withRollback(async (tx) => {
      const [chart] = await tx.insert(sizeCharts).values({ name: "Chart DB Check" }).returning();
      if (!chart) throw new Error("fixture insert failed");
      await expect(
        tx.insert(sizeChartRows).values({
          sizeChartId: chart.id,
          size: "M",
          bustCm: 0,
          lengthCm: 130,
          sleeveLengthCm: 55,
          heightRecommendationMinCm: 150,
          heightRecommendationMaxCm: 160,
        }),
      ).rejects.toThrow();
    });
  });

  test("updateSizeChart replaces every row — an old row with a value not resubmitted is gone", async () => {
    await withRollback(async (tx) => {
      const chart = await createSizeChart({ name: "Chart Awal", rows: fullRows() }, ACTOR_ID, tx);
      const updatedRows = fullRows({ M: { bustCm: 999 } });
      await updateSizeChart(chart.id, { name: "Chart Direvisi", rows: updatedRows }, ACTOR_ID, tx);

      const detail = await getSizeChartDetail(chart.id, tx);
      expect(detail?.name).toBe("Chart Direvisi");
      expect(detail?.rows.find((row) => row.size === "M")?.bustCm).toBe(999);
      expect(detail?.rows).toHaveLength(CUTTING_SIZES.length);
    });
  });

  test("getSizeChartDetail returns null for a nonexistent id", async () => {
    await withRollback(async (tx) => {
      expect(await getSizeChartDetail("00000000-0000-0000-0000-000000000000", tx)).toBeNull();
    });
  });
});

describe("listSizeCharts", () => {
  test("reports how many products currently reference each chart", async () => {
    await withRollback(async (tx) => {
      const chart = await createSizeChart({ name: "Chart Dipakai", rows: fullRows() }, ACTOR_ID, tx);
      const { product } = await insertProductVariant(tx);
      await tx.update(products).set({ sizeChartId: chart.id }).where(eq(products.id, product.id));

      const list = await listSizeCharts(tx);
      expect(list.find((row) => row.id === chart.id)?.productCount).toBe(1);
    });
  });

  test("a brand-new chart with no products shows productCount 0", async () => {
    await withRollback(async (tx) => {
      const chart = await createSizeChart({ name: "Chart Baru", rows: fullRows() }, ACTOR_ID, tx);
      const list = await listSizeCharts(tx);
      expect(list.find((row) => row.id === chart.id)?.productCount).toBe(0);
    });
  });
});

describe("deleteSizeChart", () => {
  test("deletes a chart with no products referencing it", async () => {
    await withRollback(async (tx) => {
      const chart = await createSizeChart({ name: "Chart Dihapus", rows: fullRows() }, ACTOR_ID, tx);
      await deleteSizeChart(chart.id, ACTOR_ID, tx);
      expect(await getSizeChartDetail(chart.id, tx)).toBeNull();
    });
  });

  test("refuses to delete a chart a product still points at, with a friendly message — not a raw 23503", async () => {
    await withRollback(async (tx) => {
      const chart = await createSizeChart({ name: "Chart Masih Dipakai", rows: fullRows() }, ACTOR_ID, tx);
      const { product } = await insertProductVariant(tx);
      await tx.update(products).set({ sizeChartId: chart.id }).where(eq(products.id, product.id));

      await expect(deleteSizeChart(chart.id, ACTOR_ID, tx)).rejects.toThrow(ActionError);
      // Still there afterward — the failed delete must not have partially removed its rows.
      expect(await getSizeChartDetail(chart.id, tx)).not.toBeNull();
    });
  });
});

// Confirms this suite is actually hitting a real database (sanity check against the whole file
// silently running as a no-op) — mirrors the same guard style other integration suites use.
test("sanity: testDb is reachable", async () => {
  await testDb.execute("select 1");
});
