import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { fabricColors, productImages, productVariants, products } from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";
import { defaultImageAltText } from "./alt-text";
import { PUBLISHED_LAST_PHOTO_MESSAGE } from "./photo-messages";
import { getStorageClient, getStorageKeyPrefix } from "@/lib/storage";
import { buildImageObjectKey, buildImageStorageKey } from "./image-keys";
import { IMAGE_SIZES, logUploadTiming, processUploadedImage, type ImageSize } from "./image-processing";
import { ActionError, FieldError } from "./errors";
import { defaultDb, lockProductForUpdate, writeAuditLog, type Database, type Tx } from "./db";

/** Best-effort delete of every size object under one image's storage key — used by every
 * rollback/cleanup path (a failed upload, after the fact, or a deleted image row). Never throws:
 * object storage isn't transactional, so a failure here just leaves an orphan for a future
 * sweep, logged (not silently swallowed) so it's at least visible in server logs. */
async function deleteObjectsLogged(storageKey: string, imageId: string, sizes: readonly ImageSize[] = IMAGE_SIZES): Promise<void> {
  const storage = getStorageClient();
  await Promise.allSettled(
    sizes.map(async (size) => {
      try {
        await storage.delete(buildImageObjectKey(storageKey, size));
      } catch (error) {
        console.error(`failed to delete storage object for image ${imageId} size ${size}:`, error);
      }
    }),
  );
}

// ---------- Photo rules ----------
//
// Photos never gate a variant or a product being ACTIVE: production batches, stock counts and
// orders need active SKUs long before a photo exists. A color without its own photo only gets a
// non-blocking "Belum ada foto" reminder badge in admin (listProductIdsMissingPhotos below for
// the product list, listProductColorGroups' imageCount for the product page), and the storefront falls back to the product's other
// photos, then to a static placeholder. The ONE hard photo rule is publishing: a product needs at
// least one photo to be published on the storefront (storefront.ts's updateProductStorefront),
// and the last photo of a published product can't be deleted (deleteProductImage below).

/** The subset of `productIds` with at least one color that has an ACTIVE variant but ZERO
 * color-specific images (general images don't count: the reminder is per color) — the product
 * list's "Belum ada foto" badge, in ONE query for a whole page of rows. Reminder only, never a
 * blocking check. */
export async function listProductIdsMissingPhotos(productIds: readonly string[], db: Database = defaultDb): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  // Correlated subquery on a join-less outer query: qualifiedColumn() on BOTH sides of every
  // correlation, never bare `${table.column}` (see that helper's doc comment for the drizzle bug).
  const rows = await db
    .selectDistinct({ productId: productVariants.productId })
    .from(productVariants)
    .where(
      and(
        inArray(productVariants.productId, [...productIds]),
        eq(productVariants.isActive, true),
        sql`not exists (select 1 from ${productImages} where ${qualifiedColumn(productImages, productImages.productId)} = ${qualifiedColumn(productVariants, productVariants.productId)} and ${qualifiedColumn(productImages, productImages.fabricColorId)} = ${qualifiedColumn(productVariants, productVariants.fabricColorId)})`,
      ),
    );
  return new Set(rows.map((row) => row.productId));
}

// ---------- Default alt text (see alt-text.ts) ----------
//
// The SQL below rebuilds defaultImageAltText() in Postgres: `<product>` for a general photo,
// `<product> warna <color>` for a color photo. Keep the three in sync with each other and with
// migration 0028's backfill. Hand-written SQL with literal table/column names (no interpolated
// Column objects), so there is no correlation-qualification risk (see qualifiedColumn()).

/** Fills every empty (null or whitespace-only) alt text of one product with its default.
 * Idempotent. Covers photos uploaded before default alt text existed, and any row a previous
 * release wrote empty after migration 0028 already ran (the expand/contract deploy window). */
export async function fillMissingAltTexts(productId: string, db: Database = defaultDb): Promise<void> {
  await db.execute(sql`
    update product_images
    set alt_text = (select p.name from products p where p.id = product_images.product_id)
      || coalesce((select ' warna ' || fc.name from fabric_colors fc where fc.id = product_images.fabric_color_id), '')
    where product_images.product_id = ${productId}
      and (product_images.alt_text is null or product_images.alt_text ~ '^[[:space:]]*$')
  `);
}

/** After a product rename: rewrites only the alt texts that still equal the OLD default, so
 * anything the owner typed by hand is left alone. */
export async function syncAltTextsForProductRename(productId: string, oldName: string, newName: string, db: Database = defaultDb): Promise<void> {
  if (oldName === newName) return;
  await db.execute(sql`
    update product_images
    set alt_text = ${newName} || coalesce((select ' warna ' || fc.name from fabric_colors fc where fc.id = product_images.fabric_color_id), '')
    where product_images.product_id = ${productId}
      and product_images.alt_text = ${oldName} || coalesce((select ' warna ' || fc.name from fabric_colors fc where fc.id = product_images.fabric_color_id), '')
  `);
}

/** After a color rename: same rule, across every product with photos of that color. */
export async function syncAltTextsForColorRename(fabricColorId: string, oldName: string, newName: string, db: Database = defaultDb): Promise<void> {
  if (oldName === newName) return;
  await db.execute(sql`
    update product_images
    set alt_text = (select p.name from products p where p.id = product_images.product_id) || ' warna ' || ${newName}
    where product_images.fabric_color_id = ${fabricColorId}
      and product_images.alt_text = (select p.name from products p where p.id = product_images.product_id) || ' warna ' || ${oldName}
  `);
}

/** Total images (general + every color) of a product — the storefront-publish guard's input. */
export async function countProductImages(productId: string, db: Database = defaultDb): Promise<number> {
  const [row] = await db.select({ total: count() }).from(productImages).where(eq(productImages.productId, productId));
  return row?.total ?? 0;
}

/** Required-alt-text invariant, checked at storefront-publish time (never blocks a normal photo
 * upload/save; uploads and clears now store the default alt text, so in practice only a blank
 * left by an older release can trip it, and fillMissingAltTexts runs first) — docs/plans/storefront-cms.md's "the per-color ordered images with
 * required alt text requirement is covered by making alt text required AT PUBLISH TIME
 * (app-level), not a schema change" — `product_images.alt_text` stays nullable (plenty of
 * pre-existing rows have none) so this is deliberately NOT a DB CHECK. Returns true if ANY image
 * of this product (general or per-color) has a null/empty alt text. */
export async function hasImagesMissingAltText(productId: string, db: Database = defaultDb): Promise<boolean> {
  const rows = await db.select({ altText: productImages.altText }).from(productImages).where(eq(productImages.productId, productId));
  if (rows.length === 0) return false;
  // Same whitespace class as fillMissingAltTexts' / migration 0028's `[[:space:]]`, so whatever
  // the fill treats as blank this check does too (JS `trim()` also strips Unicode spaces).
  return rows.some((row) => !row.altText || /^[ \t\n\r\f\v]*$/.test(row.altText));
}

async function countImagesInGroup(tx: Database, productId: string, fabricColorId: string | null): Promise<number> {
  const [row] = await tx
    .select({ total: count() })
    .from(productImages)
    .where(
      and(
        eq(productImages.productId, productId),
        fabricColorId ? eq(productImages.fabricColorId, fabricColorId) : isNull(productImages.fabricColorId),
      ),
    );
  return row?.total ?? 0;
}

// ---------- Read queries (product detail page) ----------

export interface ProductColorGroup {
  fabricColorId: string;
  name: string;
  hex: string | null;
  imageCount: number;
}

/** One entry per fabric color the product has ANY variant for (active or not), ordered by name
 * — the "Foto" section's color groups; `imageCount === 0` drives the "Belum ada foto" reminder
 * on both the Foto and Varian sections. */
export async function listProductColorGroups(productId: string, db: Database = defaultDb): Promise<ProductColorGroup[]> {
  const colorRows = await db
    .selectDistinct({ id: fabricColors.id, name: fabricColors.name, hex: fabricColors.hex })
    .from(productVariants)
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(productVariants.productId, productId))
    .orderBy(fabricColors.name);

  const imageCountRows = await db
    .select({ fabricColorId: productImages.fabricColorId, total: count() })
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .groupBy(productImages.fabricColorId);
  const imageCountByColor = new Map(imageCountRows.map((row) => [row.fabricColorId, row.total] as const));

  return colorRows.map((color) => ({
    fabricColorId: color.id,
    name: color.name,
    hex: color.hex,
    imageCount: imageCountByColor.get(color.id) ?? 0,
  }));
}

export interface ProductImageRow {
  id: string;
  fabricColorId: string | null;
  altText: string | null;
  width: number;
  height: number;
  sortOrder: number;
  urls: Record<ImageSize, string>;
}

function buildImageUrls(storageKey: string): Record<ImageSize, string> {
  const storage = getStorageClient();
  const entries = IMAGE_SIZES.map((size) => [size, storage.publicUrl(buildImageObjectKey(storageKey, size))] as const);
  return Object.fromEntries(entries) as Record<ImageSize, string>;
}

/** Exported for callers that already have a `storage_key` from their own query (e.g.
 * queries.ts's product list, which LEFT JOINs product_images on products.thumbnail_image_id
 * instead of running one extra query per row) and just need the URL for ONE size. */
export function buildImageSizeUrl(storageKey: string, size: ImageSize): string {
  return getStorageClient().publicUrl(buildImageObjectKey(storageKey, size));
}

/** Every image row for the product, ordered by sort_order within its own group — grouping by
 * color (general first, then per color group) is done by the caller, which already has
 * {@link listProductColorGroups}'s color ordering. */
export async function listProductImages(productId: string, db: Database = defaultDb): Promise<ProductImageRow[]> {
  const rows = await db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(asc(productImages.sortOrder));
  return rows.map((row) => ({
    id: row.id,
    fabricColorId: row.fabricColorId,
    altText: row.altText,
    width: row.width,
    height: row.height,
    sortOrder: row.sortOrder,
    urls: buildImageUrls(row.storageKey),
  }));
}

// ---------- Mutations ----------

export interface UploadProductImageInput {
  productId: string;
  fabricColorId: string | null;
  altText?: string | null;
  fileBuffer: Buffer;
}

/** One file per call, by design (see apps/admin/src/app/(shell)/products/actions.ts — the client
 * uploads sequentially, one action call per file, after downscaling in the browser). Image
 * processing (CPU-bound, no DB access) runs BEFORE any transaction or lock is taken — there is
 * no reason to hold `FOR UPDATE` on the product row while sharp resizes three buffers.
 * Objects are PUT to storage before the DB transaction opens; if the transaction then fails for
 * any reason, every object just written is deleted, per the "write objects first, insert DB
 * rows in a transaction, delete objects on DB failure" rule. */
export async function uploadProductImage(
  input: UploadProductImageInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<typeof productImages.$inferSelect> {
  const sharpStarted = performance.now();
  const processed = await processUploadedImage(input.fileBuffer);
  const sharpMs = performance.now() - sharpStarted;

  const storage = getStorageClient();
  const imageId = randomUUID();
  const storageKey = buildImageStorageKey({ keyPrefix: getStorageKeyPrefix(), productId: input.productId, imageId });

  const putSizes: ImageSize[] = [];
  const s3Started = performance.now();
  try {
    for (const size of IMAGE_SIZES) {
      await storage.put(buildImageObjectKey(storageKey, size), processed.sizes[size], "image/webp");
      putSizes.push(size);
    }
  } catch {
    await deleteObjectsLogged(storageKey, imageId, putSizes);
    throw new ActionError("Gagal mengunggah foto ke penyimpanan. Coba lagi.");
  }
  logUploadTiming("product image", {
    sharpMs,
    s3Ms: performance.now() - s3Started,
    inputBytes: input.fileBuffer.length,
    outputBytes: IMAGE_SIZES.reduce((sum, size) => sum + processed.sizes[size].length, 0),
  });

  try {
    return await db.transaction(async (tx) => {
      const product = await lockProductForUpdate(tx, input.productId);
      if (!product) throw new ActionError("Produk tidak ditemukan.");

      let colorName: string | null = null;
      if (input.fabricColorId) {
        // FOR SHARE: a concurrent color rename (updateFabricColor) waits for this upload to
        // commit, so its alt-text sync sees this row instead of leaving a stale default behind.
        const [color] = await tx.select().from(fabricColors).where(eq(fabricColors.id, input.fabricColorId)).limit(1).for("share");
        if (!color) throw new FieldError("fabricColorId", "Warna tidak ditemukan.");
        if (color.fabricId !== product.fabricId) {
          throw new FieldError("fabricColorId", `Warna "${color.name}" bukan milik bahan produk ini.`);
        }
        colorName = color.name;
      }

      const sortOrder = await countImagesInGroup(tx, product.id, input.fabricColorId);

      const [image] = await tx
        .insert(productImages)
        .values({
          id: imageId,
          productId: product.id,
          fabricId: product.fabricId,
          fabricColorId: input.fabricColorId,
          storageKey,
          // Never stored empty: an untyped alt text gets the default, which stays editable.
          altText: input.altText?.trim() || defaultImageAltText(product.name, colorName),
          width: processed.width,
          height: processed.height,
          sortOrder,
        })
        .returning();
      if (!image) throw new Error("failed to insert product image");

      // First image uploaded to a thumbnail-less product becomes the thumbnail automatically.
      if (!product.thumbnailImageId) {
        await tx.update(products).set({ thumbnailImageId: image.id }).where(eq(products.id, product.id));
      }

      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "upload",
        entityType: "product_image",
        entityId: image.id,
        after: image,
      });
      return image;
    });
  } catch (error) {
    await deleteObjectsLogged(storageKey, imageId);
    throw error;
  }
}

async function findThumbnailFallback(tx: Tx, productId: string, excludeImageId: string): Promise<string | null> {
  const [generalImage] = await tx
    .select({ id: productImages.id })
    .from(productImages)
    .where(
      and(
        eq(productImages.productId, productId),
        isNull(productImages.fabricColorId),
        ne(productImages.id, excludeImageId),
      ),
    )
    .orderBy(asc(productImages.sortOrder))
    .limit(1);
  if (generalImage) return generalImage.id;

  // INNER JOIN on fabric_colors naturally excludes general images (fabric_color_id null has no
  // match), so this is already scoped to color-specific images only.
  const [colorImage] = await tx
    .select({ id: productImages.id })
    .from(productImages)
    .innerJoin(fabricColors, eq(fabricColors.id, productImages.fabricColorId))
    .where(and(eq(productImages.productId, productId), ne(productImages.id, excludeImageId)))
    .orderBy(asc(fabricColors.name), asc(productImages.sortOrder))
    .limit(1);
  return colorImage?.id ?? null;
}

/** Deletes the row, then its storage objects (log-and-continue on object-deletion failure, per
 * spec — a future orphan-sweep script can reconcile any leftovers; not built here). Before the
 * row delete: refuses deleting the LAST photo of a product published on the storefront (the
 * publish guard's own invariant, see updateProductStorefront), and, if this image IS the
 * current thumbnail, computes and writes the fallback — required either way, since
 * products.thumbnail_image_id's FK is ON DELETE RESTRICT (see that column's doc comment in
 * packages/db/src/schema/catalog.ts for why), so the reference must be cleared before the image
 * row can be deleted at all. */
export async function deleteProductImage(
  imageId: string,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<{ productId: string }> {
  const { storageKey, productId } = await db.transaction(async (tx) => {
    const [image] = await tx.select().from(productImages).where(eq(productImages.id, imageId)).limit(1);
    if (!image) throw new ActionError("Foto tidak ditemukan.");

    const product = await lockProductForUpdate(tx, image.productId);
    if (!product) throw new ActionError("Produk tidak ditemukan.");

    // Safe against a concurrent delete/publish: both take the same product FOR UPDATE lock above.
    if (product.isPublishedOnStorefront && (await countProductImages(image.productId, tx)) <= 1) {
      throw new ActionError(PUBLISHED_LAST_PHOTO_MESSAGE);
    }

    if (product.thumbnailImageId === image.id) {
      const fallback = await findThumbnailFallback(tx, image.productId, image.id);
      await tx.update(products).set({ thumbnailImageId: fallback }).where(eq(products.id, image.productId));
    }

    await tx.delete(productImages).where(eq(productImages.id, image.id));
    await writeAuditLog(tx, { actorStaffUserId, action: "delete", entityType: "product_image", entityId: image.id, before: image });

    return { storageKey: image.storageKey, productId: image.productId };
  });

  await deleteObjectsLogged(storageKey, imageId);
  return { productId };
}

export interface ReorderProductImagesInput {
  productId: string;
  fabricColorId: string | null;
  orderedImageIds: readonly string[];
}

export async function reorderProductImages(
  input: ReorderProductImagesInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<void> {
  return db.transaction(async (tx) => {
    const product = await lockProductForUpdate(tx, input.productId);
    if (!product) throw new ActionError("Produk tidak ditemukan.");

    const rows = await tx
      .select({ id: productImages.id })
      .from(productImages)
      .where(
        and(
          eq(productImages.productId, input.productId),
          input.fabricColorId ? eq(productImages.fabricColorId, input.fabricColorId) : isNull(productImages.fabricColorId),
        ),
      );
    const actualIds = new Set(rows.map((row) => row.id));
    const requestedIds = new Set(input.orderedImageIds);
    if (actualIds.size !== requestedIds.size || [...actualIds].some((id) => !requestedIds.has(id))) {
      throw new ActionError("Urutan foto tidak valid, mungkin sudah diubah di tab lain. Muat ulang halaman.");
    }

    for (let index = 0; index < input.orderedImageIds.length; index += 1) {
      await tx.update(productImages).set({ sortOrder: index }).where(eq(productImages.id, input.orderedImageIds[index]!));
    }

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "reorder",
      entityType: "product_image",
      entityId: input.productId,
      after: { fabricColorId: input.fabricColorId, orderedImageIds: input.orderedImageIds },
    });
  });
}

export async function setProductThumbnail(
  productId: string,
  imageId: string,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<void> {
  return db.transaction(async (tx) => {
    const product = await lockProductForUpdate(tx, productId);
    if (!product) throw new ActionError("Produk tidak ditemukan.");

    const [image] = await tx.select().from(productImages).where(eq(productImages.id, imageId)).limit(1);
    if (!image) throw new ActionError("Foto tidak ditemukan.");
    if (image.productId !== productId) throw new ActionError("Foto ini bukan milik produk ini.");

    await tx.update(products).set({ thumbnailImageId: imageId }).where(eq(products.id, productId));
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "update",
      entityType: "product",
      entityId: productId,
      before: { thumbnailImageId: product.thumbnailImageId },
      after: { thumbnailImageId: imageId },
    });
  });
}

export async function updateImageAltText(
  imageId: string,
  altText: string | null,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<{ productId: string }> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(productImages).where(eq(productImages.id, imageId)).limit(1);
    if (!before) throw new ActionError("Foto tidak ditemukan.");
    // Clearing the field restores the default rather than storing an empty alt text.
    let nextAltText = altText?.trim() || null;
    if (!nextAltText) {
      // Locked like uploadProductImage (product FOR UPDATE, color FOR SHARE): a concurrent
      // product/color rename can't slip a stale default in between this read and the write.
      const product = await lockProductForUpdate(tx, before.productId);
      if (!product) throw new ActionError("Produk tidak ditemukan.");
      const [color] = before.fabricColorId
        ? await tx.select({ name: fabricColors.name }).from(fabricColors).where(eq(fabricColors.id, before.fabricColorId)).limit(1).for("share")
        : [];
      nextAltText = defaultImageAltText(product.name, color?.name ?? null);
    }
    const [after] = await tx.update(productImages).set({ altText: nextAltText }).where(eq(productImages.id, imageId)).returning();
    if (!after) throw new Error("failed to update product image");
    await writeAuditLog(tx, { actorStaffUserId, action: "update", entityType: "product_image", entityId: imageId, before, after });
    return { productId: after.productId };
  });
}
