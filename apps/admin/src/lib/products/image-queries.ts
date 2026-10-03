import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, isNull, ne } from "drizzle-orm";
import { fabricColors, productImages, productVariants, products } from "@ammari/db/schema";
import { getStorageClient, getStorageKeyPrefix } from "@/lib/storage";
import { buildImageObjectKey, buildImageStorageKey } from "./image-keys";
import { IMAGE_SIZES, processUploadedImage, type ImageSize } from "./image-processing";
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

// ---------- Required-photo invariant ----------
//
// Shared by every enforcement point: updateProduct's activation check (queries.ts),
// deleteProductImage's last-photo check, addVariants' create-inactive check (queries.ts),
// setVariantActive's check (queries.ts), and the UI's per-color warning badges. Keeping the
// query in ONE place is what keeps those four call sites from drifting apart.

export interface MissingPhotoColor {
  id: string;
  name: string;
}

/** Colors with >=1 ACTIVE variant of this product and ZERO images — general images (null
 * fabric_color_id) don't count; the invariant is per-color. */
export async function getColorsMissingPhotos(productId: string, db: Database = defaultDb): Promise<MissingPhotoColor[]> {
  const rows = await db
    .select({ id: fabricColors.id, name: fabricColors.name, imageCount: count(productImages.id) })
    .from(productVariants)
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .leftJoin(
      productImages,
      and(eq(productImages.fabricColorId, fabricColors.id), eq(productImages.productId, productId)),
    )
    .where(and(eq(productVariants.productId, productId), eq(productVariants.isActive, true)))
    .groupBy(fabricColors.id, fabricColors.name);
  return rows.filter((row) => row.imageCount === 0).map((row) => ({ id: row.id, name: row.name }));
}

export async function getImageCountForColor(
  productId: string,
  fabricColorId: string,
  db: Database = defaultDb,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(productImages)
    .where(and(eq(productImages.productId, productId), eq(productImages.fabricColorId, fabricColorId)));
  return row?.total ?? 0;
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

async function colorHasActiveVariant(tx: Database, productId: string, fabricColorId: string): Promise<boolean> {
  const [row] = await tx
    .select({ total: count() })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, productId),
        eq(productVariants.fabricColorId, fabricColorId),
        eq(productVariants.isActive, true),
      ),
    );
  return (row?.total ?? 0) > 0;
}

// ---------- Read queries (product detail page) ----------

export interface ProductColorGroup {
  fabricColorId: string;
  name: string;
  hex: string | null;
  hasActiveVariant: boolean;
  imageCount: number;
}

/** One entry per fabric color the product has ANY variant for (active or not), ordered by name
 * — the "Foto" section's color groups, each with enough to render its warning badge
 * (`hasActiveVariant && imageCount === 0`). */
export async function listProductColorGroups(productId: string, db: Database = defaultDb): Promise<ProductColorGroup[]> {
  const colorRows = await db
    .selectDistinct({ id: fabricColors.id, name: fabricColors.name, hex: fabricColors.hex })
    .from(productVariants)
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(productVariants.productId, productId))
    .orderBy(fabricColors.name);

  const activeFlagRows = await db
    .select({ fabricColorId: productVariants.fabricColorId, isActive: productVariants.isActive })
    .from(productVariants)
    .where(eq(productVariants.productId, productId));
  const hasActiveVariantByColor = new Map<string, boolean>();
  for (const row of activeFlagRows) {
    if (row.isActive) hasActiveVariantByColor.set(row.fabricColorId, true);
  }

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
    hasActiveVariant: hasActiveVariantByColor.get(color.id) ?? false,
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

/** One file per call, by design (see apps/admin/src/app/(shell)/produk/actions.ts — the client
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
  const processed = await processUploadedImage(input.fileBuffer);

  const storage = getStorageClient();
  const imageId = randomUUID();
  const storageKey = buildImageStorageKey({ keyPrefix: getStorageKeyPrefix(), productId: input.productId, imageId });

  const putSizes: ImageSize[] = [];
  try {
    for (const size of IMAGE_SIZES) {
      await storage.put(buildImageObjectKey(storageKey, size), processed.sizes[size], "image/webp");
      putSizes.push(size);
    }
  } catch {
    await deleteObjectsLogged(storageKey, imageId, putSizes);
    throw new ActionError("Gagal mengunggah foto ke penyimpanan. Coba lagi.");
  }

  try {
    return await db.transaction(async (tx) => {
      const product = await lockProductForUpdate(tx, input.productId);
      if (!product) throw new ActionError("Produk tidak ditemukan.");

      if (input.fabricColorId) {
        const [color] = await tx.select().from(fabricColors).where(eq(fabricColors.id, input.fabricColorId)).limit(1);
        if (!color) throw new FieldError("fabricColorId", "Warna tidak ditemukan.");
        if (color.fabricId !== product.fabricId) {
          throw new FieldError("fabricColorId", `Warna "${color.name}" bukan milik bahan produk ini.`);
        }
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
          altText: input.altText || null,
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
 * row delete: refuses the "last photo of an active color" case, and, if this image IS the
 * current thumbnail, computes and writes the fallback — required either way, since
 * products.thumbnail_image_id's FK is ON DELETE RESTRICT (see that column's doc comment in
 * packages/db/src/schema/catalog.ts for why), so the reference must be cleared before the image
 * row can be deleted at all. */
export async function deleteProductImage(
  imageId: string,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<void> {
  const { storageKey } = await db.transaction(async (tx) => {
    const [image] = await tx.select().from(productImages).where(eq(productImages.id, imageId)).limit(1);
    if (!image) throw new ActionError("Foto tidak ditemukan.");

    const product = await lockProductForUpdate(tx, image.productId);
    if (!product) throw new ActionError("Produk tidak ditemukan.");

    if (image.fabricColorId) {
      const currentCount = await countImagesInGroup(tx, image.productId, image.fabricColorId);
      const remainingAfterDelete = currentCount - 1;
      if (remainingAfterDelete === 0 && product.isActive && (await colorHasActiveVariant(tx, image.productId, image.fabricColorId))) {
        const [color] = await tx.select({ name: fabricColors.name }).from(fabricColors).where(eq(fabricColors.id, image.fabricColorId)).limit(1);
        throw new ActionError(
          `Tidak bisa menghapus foto terakhir warna "${color?.name ?? ""}" selagi produk aktif dan warna ini punya varian aktif.`,
        );
      }
    }

    if (product.thumbnailImageId === image.id) {
      const fallback = await findThumbnailFallback(tx, image.productId, image.id);
      await tx.update(products).set({ thumbnailImageId: fallback }).where(eq(products.id, image.productId));
    }

    await tx.delete(productImages).where(eq(productImages.id, image.id));
    await writeAuditLog(tx, { actorStaffUserId, action: "delete", entityType: "product_image", entityId: image.id, before: image });

    return { storageKey: image.storageKey };
  });

  await deleteObjectsLogged(storageKey, imageId);
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
): Promise<void> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(productImages).where(eq(productImages.id, imageId)).limit(1);
    if (!before) throw new ActionError("Foto tidak ditemukan.");
    const [after] = await tx.update(productImages).set({ altText }).where(eq(productImages.id, imageId)).returning();
    if (!after) throw new Error("failed to update product image");
    await writeAuditLog(tx, { actorStaffUserId, action: "update", entityType: "product_image", entityId: imageId, before, after });
  });
}
