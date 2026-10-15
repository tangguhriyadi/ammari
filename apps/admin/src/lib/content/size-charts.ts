import "server-only";
import { eq, inArray } from "drizzle-orm";
import { CUTTING_SIZES, type CuttingSize, products, sizeCharts, sizeChartRows } from "@ammari/db/schema";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { ActionError, FieldError, isPostgresErrorCode } from "@/lib/errors";

// ---------- Size charts (docs/plans/storefront-cms.md) ----------
//
// Fixed measurement columns, ONE row per CUTTING_SIZES entry (XS-XL — ALLSIZE never has a chart
// row, see schema/content.ts's own doc comment) — never admin-defined columns. A chart is always
// saved as a whole (name + all 5 rows) in one transaction, never row-by-row, so a chart can never
// be left with only some of its sizes filled in.

export interface SizeChartRowInput {
  size: CuttingSize;
  bustCm: number;
  lengthCm: number;
  sleeveLengthCm: number;
  heightRecommendationMinCm: number;
  heightRecommendationMaxCm: number;
}

export interface SizeChartInput {
  name: string;
  rows: SizeChartRowInput[];
}

export interface SizeChartListItem {
  id: string;
  name: string;
  productCount: number;
}

export async function listSizeCharts(db: Database = defaultDb): Promise<SizeChartListItem[]> {
  const charts = await db.select({ id: sizeCharts.id, name: sizeCharts.name }).from(sizeCharts).orderBy(sizeCharts.name);
  if (charts.length === 0) return [];

  const usage = await db
    .select({ sizeChartId: products.sizeChartId })
    .from(products)
    .where(inArray(products.sizeChartId, charts.map((chart) => chart.id)));
  const countBySizeChartId = new Map<string, number>();
  for (const row of usage) {
    if (!row.sizeChartId) continue;
    countBySizeChartId.set(row.sizeChartId, (countBySizeChartId.get(row.sizeChartId) ?? 0) + 1);
  }

  return charts.map((chart) => ({ ...chart, productCount: countBySizeChartId.get(chart.id) ?? 0 }));
}

export interface SizeChartDetail {
  id: string;
  name: string;
  rows: SizeChartRowInput[];
}

/** Rows always come back in CUTTING_SIZES' own canonical order, never storage order — same
 * "canonical order wins, never insertion order" idiom PRODUCT_HIGHLIGHT_KEYS already uses. */
export async function getSizeChartDetail(id: string, db: Database = defaultDb): Promise<SizeChartDetail | null> {
  const [chart] = await db.select({ id: sizeCharts.id, name: sizeCharts.name }).from(sizeCharts).where(eq(sizeCharts.id, id)).limit(1);
  if (!chart) return null;

  const rows = await db
    .select({
      size: sizeChartRows.size,
      bustCm: sizeChartRows.bustCm,
      lengthCm: sizeChartRows.lengthCm,
      sleeveLengthCm: sizeChartRows.sleeveLengthCm,
      heightRecommendationMinCm: sizeChartRows.heightRecommendationMinCm,
      heightRecommendationMaxCm: sizeChartRows.heightRecommendationMaxCm,
    })
    .from(sizeChartRows)
    .where(eq(sizeChartRows.sizeChartId, id));

  const bySize = new Map<CuttingSize, SizeChartRowInput>(rows.map((row) => [row.size as CuttingSize, row as SizeChartRowInput]));
  return {
    id: chart.id,
    name: chart.name,
    rows: CUTTING_SIZES.map((size) => bySize.get(size)).filter((row): row is SizeChartRowInput => row !== undefined),
  };
}

function validateRows(rows: SizeChartRowInput[]): void {
  const sizes = rows.map((row) => row.size);
  if (sizes.length !== CUTTING_SIZES.length || !CUTTING_SIZES.every((size) => sizes.includes(size))) {
    throw new ActionError("Tabel ukuran harus memiliki baris untuk setiap ukuran (XS, S, M, L, XL).");
  }
  for (const row of rows) {
    if (row.heightRecommendationMaxCm < row.heightRecommendationMinCm) {
      throw new FieldError(
        `height-${row.size}`,
        `Tinggi maksimum ukuran ${row.size} tidak boleh lebih kecil dari tinggi minimum.`,
      );
    }
  }
}

async function replaceRows(tx: Tx, sizeChartId: string, rows: SizeChartRowInput[]): Promise<void> {
  await tx.delete(sizeChartRows).where(eq(sizeChartRows.sizeChartId, sizeChartId));
  await tx.insert(sizeChartRows).values(rows.map((row) => ({ sizeChartId, ...row })));
}

export async function createSizeChart(
  input: SizeChartInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<SizeChartDetail> {
  validateRows(input.rows);
  return db.transaction(async (tx) => {
    const [chart] = await tx.insert(sizeCharts).values({ name: input.name }).returning();
    if (!chart) throw new Error("failed to insert size chart");
    await replaceRows(tx, chart.id, input.rows);
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "create",
      entityType: "size_chart",
      entityId: chart.id,
      after: { name: chart.name, rows: input.rows },
    });
    return { id: chart.id, name: chart.name, rows: input.rows };
  });
}

export async function updateSizeChart(
  id: string,
  input: SizeChartInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<SizeChartDetail> {
  validateRows(input.rows);
  return db.transaction(async (tx) => {
    const before = await getSizeChartDetail(id, tx);
    if (!before) throw new ActionError("Tabel ukuran tidak ditemukan.");

    const [after] = await tx.update(sizeCharts).set({ name: input.name }).where(eq(sizeCharts.id, id)).returning();
    if (!after) throw new Error("failed to update size chart");
    await replaceRows(tx, id, input.rows);
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "update",
      entityType: "size_chart",
      entityId: id,
      before,
      after: { name: after.name, rows: input.rows },
    });
    return { id, name: after.name, rows: input.rows };
  });
}

/** Rejected with a friendly message when any product still points at this chart —
 * `products.size_chart_id` is ON DELETE RESTRICT (schema/catalog.ts), so Postgres itself refuses
 * the delete; this just turns the raw 23503 into Indonesian copy instead of a stack trace. */
export async function deleteSizeChart(id: string, actorStaffUserId: string | null, db: Database = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await getSizeChartDetail(id, tx);
    if (!before) throw new ActionError("Tabel ukuran tidak ditemukan.");
    try {
      await tx.delete(sizeChartRows).where(eq(sizeChartRows.sizeChartId, id));
      await tx.delete(sizeCharts).where(eq(sizeCharts.id, id));
    } catch (error) {
      if (isPostgresErrorCode(error, "23503")) {
        throw new ActionError("Tabel ukuran masih dipakai oleh satu atau lebih produk, tidak bisa dihapus.");
      }
      throw error;
    }
    await writeAuditLog(tx, { actorStaffUserId, action: "delete", entityType: "size_chart", entityId: id, before });
  });
}
