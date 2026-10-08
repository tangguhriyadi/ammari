import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import {
  accessories,
  productAccessoryRecipes,
  productionBatchAccessoryOverrides,
  productionBatchItems,
  products,
  productVariants,
} from "@ammari/db/schema";
import type { Size } from "@ammari/db/schema";
import { ActionError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { getAccessoryBalances } from "@/lib/inventory/accessories";
import { lockProductionBatchForUpdate } from "./db";

export interface BatchLineForRecipe {
  sku: string;
  qty: number;
}

/** A recipe row this batch's lines could not resolve to a concrete accessory — the caller
 * decides what to do with it (draft display shows a warning; postBatch rejects on any non-empty
 * list — see that function). */
export interface UnresolvedRecipeRow {
  productName: string;
  size: string;
  sizeGroup: string;
}

export interface AccessoryNeedsResolution {
  neededByAccessoryId: Map<string, number>;
  unresolved: UnresolvedRecipeRow[];
}

/** Resolves a batch's lines (SKU + qty) against every referenced product's accessory recipe
 * (`product_accessory_recipes`) into a per-accessory total quantity needed.
 *
 * - A recipe row naming one specific `accessoryId` resolves directly, regardless of the
 *   variant's size — the plan's "size-independent" case (e.g. "Hang tag").
 * - A recipe row naming a `sizeGroup` resolves PER VARIANT: the variant's own `size` column is
 *   the resolution key as-is — a sized variant's XS/S/M/L/XL, or an all-size variant's ALLSIZE,
 *   which doubles as "Polos" (see `accessories.size`'s own doc comment — no separate mapping
 *   needed) — matched against `accessories.size_group` (citext, compared case-insensitively here
 *   via `.toLowerCase()` on both sides, mirroring how the DB itself already compares it when
 *   pulling `sizeGroupAccessoryRows` below) + `accessories.size`.
 *
 * A row that can't be resolved this way is never thrown from here — it's pushed onto
 * `unresolved` instead, so the CALLER decides what that means. */
export async function resolveAccessoryNeeds(
  lines: readonly BatchLineForRecipe[],
  db: Database = defaultDb,
): Promise<AccessoryNeedsResolution> {
  const neededByAccessoryId = new Map<string, number>();
  const unresolved: UnresolvedRecipeRow[] = [];
  if (lines.length === 0) return { neededByAccessoryId, unresolved };

  const qtyBySku = new Map(lines.map((line) => [line.sku, line.qty]));
  const skus = [...qtyBySku.keys()];

  const variantRows = await db
    .select({
      sku: productVariants.sku,
      size: productVariants.size,
      productId: products.id,
      productName: products.name,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.sku, skus));

  const productIds = [...new Set(variantRows.map((row) => row.productId))];
  if (productIds.length === 0) return { neededByAccessoryId, unresolved };

  const recipeRows = await db
    .select()
    .from(productAccessoryRecipes)
    .where(inArray(productAccessoryRecipes.productId, productIds));
  if (recipeRows.length === 0) return { neededByAccessoryId, unresolved };

  const sizeGroups = [...new Set(recipeRows.filter((row) => row.sizeGroup !== null).map((row) => row.sizeGroup!))];
  const sizeGroupAccessoryRows =
    sizeGroups.length > 0 ? await db.select().from(accessories).where(inArray(accessories.sizeGroup, sizeGroups)) : [];

  // Keyed by lowercase(sizeGroup) + "::" + size. citext already made the `inArray` lookup above
  // case-insensitive at the SQL level, but a plain JS Map key still needs its own normalization.
  const accessoryBySizeGroupAndSize = new Map(
    sizeGroupAccessoryRows
      .filter((row) => row.sizeGroup !== null)
      .map((row) => [`${row.sizeGroup!.toLowerCase()}::${row.size}`, row]),
  );

  const recipesByProductId = new Map<string, typeof recipeRows>();
  for (const recipe of recipeRows) {
    const list = recipesByProductId.get(recipe.productId) ?? [];
    list.push(recipe);
    recipesByProductId.set(recipe.productId, list);
  }

  function addNeed(accessoryId: string, qty: number) {
    neededByAccessoryId.set(accessoryId, (neededByAccessoryId.get(accessoryId) ?? 0) + qty);
  }

  for (const variant of variantRows) {
    const lineQty = qtyBySku.get(variant.sku);
    if (!lineQty) continue;
    const recipes = recipesByProductId.get(variant.productId) ?? [];
    for (const recipe of recipes) {
      const neededQty = recipe.qtyPerPcs * lineQty;
      if (recipe.accessoryId !== null) {
        addNeed(recipe.accessoryId, neededQty);
        continue;
      }
      const match = accessoryBySizeGroupAndSize.get(`${recipe.sizeGroup!.toLowerCase()}::${variant.size}`);
      if (!match) {
        unresolved.push({ productName: variant.productName, size: variant.size, sizeGroup: recipe.sizeGroup! });
        continue;
      }
      addNeed(match.id, neededQty);
    }
  }

  return { neededByAccessoryId, unresolved };
}

export interface AccessoryNeedRow {
  accessoryId: string;
  accessoryName: string;
  size: Size | null;
  sizeGroup: string | null;
  computedQty: number;
  overrideQty: number | null;
  effectiveQty: number;
  currentStock: number;
  shortage: boolean;
}

export interface AccessoryNeedsForBatch {
  rows: AccessoryNeedRow[];
  unresolved: UnresolvedRecipeRow[];
}

/** The draft display's data source for "Kebutuhan aksesoris" — resolves against the batch's
 * CURRENTLY SAVED lines (read from `production_batch_items`, not whatever a client's form state
 * happens to hold), folds in any per-accessory override, and reads each accessory's current
 * stock to flag a shortage. Quantities only — never a cost/value field, so this is safe to show
 * to any production.manage session regardless of finance.view_profit or inventory.view. */
export async function getAccessoryNeedsForBatch(batchId: string, db: Database = defaultDb): Promise<AccessoryNeedsForBatch> {
  const lines = await db
    .select({ sku: productionBatchItems.sku, qty: productionBatchItems.qty })
    .from(productionBatchItems)
    .where(eq(productionBatchItems.productionBatchId, batchId));

  const { neededByAccessoryId, unresolved } = await resolveAccessoryNeeds(lines, db);
  if (neededByAccessoryId.size === 0) return { rows: [], unresolved };

  const accessoryIds = [...neededByAccessoryId.keys()];
  const accessoryRows = await db.select().from(accessories).where(inArray(accessories.id, accessoryIds));
  const accessoryById = new Map(accessoryRows.map((row) => [row.id, row]));

  const overrideRows = await db
    .select()
    .from(productionBatchAccessoryOverrides)
    .where(
      and(
        eq(productionBatchAccessoryOverrides.productionBatchId, batchId),
        inArray(productionBatchAccessoryOverrides.accessoryId, accessoryIds),
      ),
    );
  const overrideByAccessoryId = new Map(overrideRows.map((row) => [row.accessoryId, row.overrideQty]));

  // Batched (one query for every needed accessory), not one getAccessoryBalance call per
  // accessory in this loop — this is a read-only display path, not a write-deciding one, so
  // there's no per-row lock to justify N round-trips (database-reviewer finding).
  const balances = await getAccessoryBalances(accessoryIds, db);

  const rows: AccessoryNeedRow[] = [];
  for (const [accessoryId, computedQty] of neededByAccessoryId) {
    const accessory = accessoryById.get(accessoryId);
    if (!accessory) continue; // deleted/renamed between resolution and here — defensive, not expected (accessories are never hard-deleted)
    const overrideQty = overrideByAccessoryId.get(accessoryId) ?? null;
    const effectiveQty = overrideQty ?? computedQty;
    const balance = balances.get(accessoryId) ?? { qty: 0, valueAmount: 0 };
    rows.push({
      accessoryId,
      accessoryName: accessory.name,
      size: accessory.size,
      sizeGroup: accessory.sizeGroup,
      computedQty,
      overrideQty,
      effectiveQty,
      currentStock: balance.qty,
      shortage: effectiveQty > balance.qty,
    });
  }
  rows.sort((a, b) => a.accessoryName.localeCompare(b.accessoryName));

  return { rows, unresolved };
}

/** Sets (or, with `overrideQty: null`, clears) one accessory's per-batch override — a single-row
 * action, not a batch-save of the whole needs table, same "smaller diff, lower risk" idiom as
 * this codebase's void-purchase button / cost-component active toggle. Only valid while the
 * batch is still a draft (locked first, same reasoning every other draft-mutating query in this
 * module locks the batch row first). */
export async function saveAccessoryOverride(
  batchId: string,
  accessoryId: string,
  overrideQty: number | null,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<void> {
  if (overrideQty !== null && (!Number.isInteger(overrideQty) || overrideQty < 0)) {
    throw new ActionError("Jumlah override harus bilangan bulat dan tidak boleh negatif.");
  }

  return db.transaction(async (tx) => {
    const batch = await lockProductionBatchForUpdate(tx, batchId);
    if (!batch) throw new ActionError("Batch tidak ditemukan.");
    if (batch.status !== "draft") throw new ActionError("Batch yang sudah diposting tidak bisa diubah.");

    if (overrideQty === null) {
      await tx
        .delete(productionBatchAccessoryOverrides)
        .where(
          and(
            eq(productionBatchAccessoryOverrides.productionBatchId, batchId),
            eq(productionBatchAccessoryOverrides.accessoryId, accessoryId),
          ),
        );
      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "clear_override",
        entityType: "production_batch_accessory_override",
        entityId: `${batchId}:${accessoryId}`,
      });
      return;
    }

    await tx
      .insert(productionBatchAccessoryOverrides)
      .values({ productionBatchId: batchId, accessoryId, overrideQty })
      .onConflictDoUpdate({
        target: [productionBatchAccessoryOverrides.productionBatchId, productionBatchAccessoryOverrides.accessoryId],
        set: { overrideQty },
      });
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "set_override",
      entityType: "production_batch_accessory_override",
      entityId: `${batchId}:${accessoryId}`,
      after: { overrideQty },
    });
  });
}
