import "server-only";
import { eq } from "drizzle-orm";
import { accessories, productAccessoryRecipes } from "@ammari/db/schema";
import { FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";

export interface RecipeLineInput {
  /** Exactly one of accessoryId/sizeGroup — enforced by the DB CHECK too, but validated here
   * first for a friendly field-scoped message instead of a raw constraint error. */
  accessoryId?: string | null;
  sizeGroup?: string | null;
  qtyPerPcs: number;
}

export interface RecipeLineRow {
  id: string;
  accessoryId: string | null;
  accessoryName: string | null;
  sizeGroup: string | null;
  qtyPerPcs: number;
}

export async function listRecipeForProduct(productId: string, db: Database = defaultDb): Promise<RecipeLineRow[]> {
  const rows = await db
    .select({
      id: productAccessoryRecipes.id,
      accessoryId: productAccessoryRecipes.accessoryId,
      accessoryName: accessories.name,
      sizeGroup: productAccessoryRecipes.sizeGroup,
      qtyPerPcs: productAccessoryRecipes.qtyPerPcs,
    })
    .from(productAccessoryRecipes)
    .leftJoin(accessories, eq(accessories.id, productAccessoryRecipes.accessoryId))
    .where(eq(productAccessoryRecipes.productId, productId))
    .orderBy(productAccessoryRecipes.createdAt);
  return rows;
}

/** Full replace-the-set for one product's recipe, in one transaction with a single audit_log
 * entry — same reasoning production_batch_items' own delete-all-reinsert uses (see that
 * function's doc comment in lib/production/queries.ts): these rows are current configuration,
 * not a history that needs to survive unrelated edits, so the simplest correct model is "the
 * lines submitted are now the whole set". Every line is validated BEFORE the transaction starts
 * (exactly one of accessoryId/sizeGroup, qtyPerPcs > 0), so a bad row never leaves a
 * half-replaced recipe behind. */
export async function saveRecipeForProduct(
  productId: string,
  lines: readonly RecipeLineInput[],
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<RecipeLineRow[]> {
  // A duplicate accessoryId/sizeGroup within THIS submission would hit the partial unique
  // indexes (product_accessory_recipes_product_id_{accessory_id,size_group}_key) at insert time
  // regardless — correctness isn't at risk — but rejecting it here first gives a friendly,
  // field-scoped message instead of a raw constraint error reaching the UI.
  const seenAccessoryIds = new Set<string>();
  const seenSizeGroups = new Set<string>();
  lines.forEach((line, index) => {
    const hasAccessory = line.accessoryId !== null && line.accessoryId !== undefined;
    const hasSizeGroup = line.sizeGroup !== null && line.sizeGroup !== undefined && line.sizeGroup !== "";
    if (hasAccessory === hasSizeGroup) {
      throw new FieldError(`lines.${index}.accessoryId`, "Pilih satu aksesoris ATAU satu grup ukuran untuk setiap baris.");
    }
    if (!Number.isInteger(line.qtyPerPcs) || line.qtyPerPcs <= 0) {
      throw new FieldError(`lines.${index}.qtyPerPcs`, "Jumlah per pcs harus bilangan bulat lebih dari 0.");
    }
    if (hasAccessory) {
      if (seenAccessoryIds.has(line.accessoryId!)) {
        throw new FieldError(`lines.${index}.accessoryId`, "Aksesoris ini sudah ada di baris lain.");
      }
      seenAccessoryIds.add(line.accessoryId!);
    } else {
      const key = line.sizeGroup!.toLowerCase();
      if (seenSizeGroups.has(key)) {
        throw new FieldError(`lines.${index}.sizeGroup`, "Grup ukuran ini sudah ada di baris lain.");
      }
      seenSizeGroups.add(key);
    }
  });

  return db.transaction(async (tx) => {
    const before = await listRecipeForProduct(productId, tx);

    await tx.delete(productAccessoryRecipes).where(eq(productAccessoryRecipes.productId, productId));

    if (lines.length > 0) {
      await tx.insert(productAccessoryRecipes).values(
        lines.map((line) => ({
          productId,
          accessoryId: line.accessoryId || null,
          sizeGroup: line.sizeGroup || null,
          qtyPerPcs: line.qtyPerPcs,
        })),
      );
    }

    const after = await listRecipeForProduct(productId, tx);
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "update",
      entityType: "product_accessory_recipe",
      entityId: productId,
      before: { lines: before },
      after: { lines: after },
    });
    return after;
  });
}
