import "server-only";
import { and, count, desc, eq, ilike, lte, type SQL } from "drizzle-orm";
import { costAssumptions, fabricColors, fabrics, productImages, products, productTypes, productVariants } from "@ammari/db/schema";
import type { ProductClosure, Size, SizeMode } from "@ammari/db/schema";
import { generateSku } from "@ammari/db/catalog";
import { discountStatus, resolveUnitPrice, validateDiscountPrice, type DiscountStatus } from "@ammari/db/pricing";
import { productPricingColumns } from "@ammari/db/pricing-columns";
import { sizeLabel } from "@ammari/commerce/size-label";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { ActionError, FieldError, isPostgresErrorCode, mapUniqueViolation } from "./errors";
import { basePriceBreaksDiscountMessage } from "./discount";
import { mapDiscountConstraintViolation } from "./discount-queries";
import { buildImageSizeUrl, listProductIdsMissingPhotos, syncAltTextsForProductRename } from "./image-queries";
import { todayInJakarta } from "./jakarta-date";
import { SHIPPING_WEIGHT_REQUIRED_WHILE_PUBLISHED_MESSAGE } from "./shipping-weight";
import { defaultDb, lockProductForUpdate, writeAuditLog, type Database } from "./db";
import { lockSelectableProductType } from "@/lib/product-types/queries";

const PRODUCT_CONSTRAINT_FIELDS = {
  products_slug_unique: { field: "slug", message: "Slug ini sudah dipakai, gunakan slug lain." },
  products_code_unique: { field: "code", message: "Kode produk ini sudah dipakai, gunakan kode lain." },
};

// ---------- Products ----------

export interface CreateProductInput {
  name: string;
  code: string;
  slug: string;
  fabricId: string;
  closure: ProductClosure;
  sizeMode: SizeMode;
  basePrice: number;
  description?: string | null;
  isActive: boolean;
  /** Already validated + trimmed by the caller (actions.ts's highlightsSchema) — this layer
   * just passes it straight through to the `highlights` column, same as every other field. */
  highlights: string[];
  /** "Berat kirim (gram)", one packed piece; optional (docs/plans/cart-checkout.md §4.5.3). */
  shippingWeightGrams?: number | null;
  /** "Jenis produk" (docs/plans/product-types.md) — must be an existing, ACTIVE type. */
  productTypeCode: string;
}

export interface UpdateProductInput {
  name: string;
  slug: string;
  fabricId: string;
  closure: ProductClosure;
  basePrice: number;
  description?: string | null;
  isActive: boolean;
  highlights: string[];
  /** `undefined` keeps the stored weight; `null` clears it, refused while the product is
   * published (a product only goes live with a weight, storefront.ts). */
  shippingWeightGrams?: number | null;
  /** `undefined` keeps the stored type (the admin form always sends it; older callers may not).
   * A CHANGED type must be active; re-saving the product's
   * current, since-deactivated type is allowed (it stays shown on products that use it). */
  productTypeCode?: string;
}

export interface ProductListFilters {
  q?: string;
  /** Exact product_types.code; already validated by the caller (unknown codes simply match nothing). */
  productTypeCode?: string;
}

export async function listProducts(
  filters: ProductListFilters,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
  now: Date = new Date(),
): Promise<{
  rows: (Omit<
    Awaited<ReturnType<typeof queryProductsPage>>[number],
    "thumbnailStorageKey" | "shippingWeightGrams" | "discountPriceAmount" | "discountEnabled" | "discountStartsAt" | "discountEndsAt"
  > & {
    thumbnailUrl: string | null;
    /** At least one active color has no photo of its own yet — the list's non-blocking
     * "Belum ada foto" reminder badge (see image-queries.ts's listProductIdsMissingPhotos). */
    missingPhotos: boolean;
    /** An active product without "Berat kirim": it cannot go live, and if it is already live
     * (published before the rule) checkout refuses it. The "Berat kirim belum diisi" badge. */
    missingShippingWeight: boolean;
    /** The discount chip (docs/plans/product-discount.md §9); null when no sale price is stored. */
    discountStatus: DiscountStatus | null;
    /** What the storefront charges right now: the sale price while the discount is active,
     * otherwise the base price. */
    effectivePrice: number;
  })[];
  pagination: Pagination;
}> {
  const conditions = [
    filters.q ? ilike(products.name, `%${filters.q}%`) : undefined,
    filters.productTypeCode ? eq(products.productTypeCode, filters.productTypeCode) : undefined,
  ].filter((condition) => condition !== undefined);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalCountRow] = await db
    .select({ totalCount: count() })
    .from(products)
    .where(where);

  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });
  const rawRows = await queryProductsPage(db, where, pagination);
  const missingPhotoIds = await listProductIdsMissingPhotos(rawRows.map((row) => row.id), db);
  // Built from a plain column (storage_key), not a query — a thumbnail-less product's row is
  // excluded from the join (LEFT JOIN), not merely an empty string, so `null` here always means
  // "no thumbnail set", matching products.thumbnail_image_id's own null-ness exactly.
  const rows = rawRows.map(
    ({ thumbnailStorageKey, shippingWeightGrams, discountPriceAmount, discountEnabled, discountStartsAt, discountEndsAt, ...row }) => {
      const pricing = { basePrice: row.basePrice, discountPriceAmount, discountEnabled, discountStartsAt, discountEndsAt };
      return {
        ...row,
        thumbnailUrl: thumbnailStorageKey ? buildImageSizeUrl(thumbnailStorageKey, 400) : null,
        missingPhotos: missingPhotoIds.has(row.id),
        missingShippingWeight: row.isActive && shippingWeightGrams === null,
        discountStatus: discountPriceAmount === null ? null : discountStatus(pricing, now),
        effectivePrice: resolveUnitPrice(pricing, now).unitPrice,
      };
    },
  );
  return { rows, pagination };
}

function queryProductsPage(db: Database, where: SQL | undefined, pagination: Pagination) {
  return db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      closure: products.closure,
      ...productPricingColumns,
      isActive: products.isActive,
      highlights: products.highlights,
      shippingWeightGrams: products.shippingWeightGrams,
      fabricName: fabrics.name,
      productTypeCode: products.productTypeCode,
      productTypeName: productTypes.name,
      productTypeIsActive: productTypes.isActive,
      activeVariantCount: count(productVariants.sku),
      thumbnailStorageKey: productImages.storageKey,
    })
    .from(products)
    .innerJoin(fabrics, eq(fabrics.id, products.fabricId))
    .innerJoin(productTypes, eq(productTypes.code, products.productTypeCode))
    .leftJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isActive, true)))
    .leftJoin(productImages, eq(productImages.id, products.thumbnailImageId))
    .where(where)
    .groupBy(products.id, fabrics.name, productTypes.code, productImages.storageKey)
    .orderBy(products.name, products.id)
    .limit(pagination.limit)
    .offset(pagination.offset);
}

export async function getProductById(id: string, db: Database = defaultDb) {
  const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  return product ?? null;
}

/** Just the slug — the one column every revalidation call in actions.ts needs to build
 * `/products/[slug]` (docs/plans/storefront-cms.md session 6), without pulling the whole product
 * row for call sites that only have a productId in hand (e.g. after a photo delete). */
export async function getProductSlug(id: string, db: Database = defaultDb): Promise<string | null> {
  const [row] = await db.select({ slug: products.slug }).from(products).where(eq(products.id, id)).limit(1);
  return row?.slug ?? null;
}

export async function getVariantCount(productId: string, db: Database = defaultDb): Promise<number> {
  const [row] = await db.select({ total: count() }).from(productVariants).where(eq(productVariants.productId, productId));
  return row?.total ?? 0;
}

export async function getProductDetail(id: string, db: Database = defaultDb) {
  const product = await getProductById(id, db);
  if (!product) return null;
  const [fabric] = await db.select().from(fabrics).where(eq(fabrics.id, product.fabricId)).limit(1);
  const [productType] = await db
    .select({ code: productTypes.code, name: productTypes.name, isActive: productTypes.isActive })
    .from(productTypes)
    .where(eq(productTypes.code, product.productTypeCode))
    .limit(1);
  const variants = await db
    .select({
      sku: productVariants.sku,
      size: productVariants.size,
      priceOverrideAmount: productVariants.priceOverrideAmount,
      minStockQty: productVariants.minStockQty,
      isActive: productVariants.isActive,
      fabricColorId: productVariants.fabricColorId,
      colorName: fabricColors.name,
      colorHex: fabricColors.hex,
    })
    .from(productVariants)
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(productVariants.productId, id))
    .orderBy(fabricColors.name, productVariants.size);
  return { product, fabric: fabric ?? null, productType: productType ?? null, variants };
}

export async function createProduct(
  input: CreateProductInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    // Friendly, field-scoped refusal of a missing/inactive type, and a FOR SHARE lock so the type
    // can't be deactivated between this check and the insert. The FK is the existence backstop.
    await lockSelectableProductType(tx, input.productTypeCode);
    try {
      const [product] = await tx.insert(products).values(input).returning();
      if (!product) throw new Error("failed to insert product");
      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "create",
        entityType: "product",
        entityId: product.id,
        after: product,
      });
      return product;
    } catch (error) {
      mapUniqueViolation(error, PRODUCT_CONSTRAINT_FIELDS);
    }
  });
}

const FABRIC_IMMUTABLE_MESSAGE = "Bahan tidak bisa diganti setelah varian dibuat. Buat produk baru untuk bahan lain.";
const CLOSURE_IMMUTABLE_MESSAGE =
  "Model resleting tidak bisa diganti setelah varian dibuat, karena sudah menjadi bagian dari kode SKU.";

/** `sizeMode` is intentionally not part of UpdateProductInput — it is immutable after creation
 * (see products.sizeMode's doc comment in packages/db/src/schema/catalog.ts), so there is
 * nothing to guard here: it simply cannot be set through this function at all.
 *
 * `fabricId` and `closure` ARE part of this input, but each is rejected with a friendly error
 * once the product has any variant — the composite FK (product_variants.product_id, fabric_id,
 * closure) -> products(id, fabric_id, closure) ON UPDATE RESTRICT (migration 0007; migration
 * 0006 originally covered just fabric_id) is the actual DB-level guarantee behind both; these
 * checks only exist to turn that into a friendly, field-specific message instead of a raw
 * constraint error. */
export async function updateProduct(
  id: string,
  input: UpdateProductInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    // FOR UPDATE — serializes against a concurrent addVariants on this same product (see
    // lockProductForUpdate's doc comment), so the variant-count check below can't race a new
    // variant in. Photos play no part in activating a product (or its variants); the only photo
    // guard is publishing to the storefront (storefront.ts's updateProductStorefront).
    const before = await lockProductForUpdate(tx, id);
    if (!before) throw new ActionError("Produk tidak ditemukan.");

    // Mirrors "the last photo of a published product cannot be deleted": a live product keeps its
    // weight. Clearing one it never had (published before the rule) is not a change, so allowed.
    if (input.shippingWeightGrams === null && before.shippingWeightGrams !== null && before.isPublishedOnStorefront) {
      throw new FieldError("shippingWeightGrams", SHIPPING_WEIGHT_REQUIRED_WHILE_PUBLISHED_MESSAGE);
    }

    // A stored sale price must stay valid against the new base price (docs/plans/product-discount.md
    // §3.2): below it and at least 1% off, toggle on or off. products_discount_price_amount_check
    // enforces the same; this turns it into the plan's message on the base price field.
    const storedSalePrice = before.discountPriceAmount;
    if (storedSalePrice !== null && validateDiscountPrice(input.basePrice, storedSalePrice) !== null) {
      throw new FieldError("basePrice", basePriceBreaksDiscountMessage(storedSalePrice));
    }

    if (input.productTypeCode !== undefined && input.productTypeCode !== before.productTypeCode) {
      await lockSelectableProductType(tx, input.productTypeCode);
    }

    const fabricChanged = input.fabricId !== before.fabricId;
    const closureChanged = input.closure !== before.closure;
    if (fabricChanged || closureChanged) {
      const variantCount = await getVariantCount(id, tx);
      if (variantCount > 0) {
        if (fabricChanged) throw new FieldError("fabricId", FABRIC_IMMUTABLE_MESSAGE);
        throw new FieldError("closure", CLOSURE_IMMUTABLE_MESSAGE);
      }
    }

    try {
      const [after] = await tx.update(products).set(input).where(eq(products.id, id)).returning();
      if (!after) throw new Error("failed to update product");
      // Photos still carrying the default alt text follow the rename; hand-written ones don't.
      await syncAltTextsForProductRename(id, before.name, after.name, tx);
      await writeAuditLog(tx, { actorStaffUserId, action: "update", entityType: "product", entityId: id, before, after });
      return after;
    } catch (error) {
      // 23503 here means a variant was created concurrently, between the check above and this
      // UPDATE — the composite FK (product_variants.product_id, fabric_id, closure) ->
      // products(id, fabric_id, closure) ON UPDATE RESTRICT is what actually caught it. Same
      // friendly messages as the pre-check above, just reached via the race path instead of the
      // common one; fabricChanged/closureChanged (captured before the UPDATE) still tell us which
      // field to blame.
      if (isPostgresErrorCode(error, "23503")) {
        if (fabricChanged) throw new FieldError("fabricId", FABRIC_IMMUTABLE_MESSAGE);
        throw new FieldError("closure", CLOSURE_IMMUTABLE_MESSAGE);
      }
      // Backstop for the discount pre-check above (the row is locked, so this should not fire).
      if (storedSalePrice !== null) mapDiscountConstraintViolation(error, { from: "basePrice", discountPriceAmount: storedSalePrice });
      mapUniqueViolation(error, PRODUCT_CONSTRAINT_FIELDS);
    }
  });
}

// ---------- Variants ----------

function validateSizesForMode(sizeMode: SizeMode, sizes: readonly Size[]): void {
  if (sizes.length === 0) throw new FieldError("sizes", "Pilih minimal satu ukuran.");
  if (sizeMode === "sized" && sizes.includes("ALLSIZE")) {
    throw new FieldError("sizes", "Produk ini menggunakan ukuran XS-XL, bukan All Size.");
  }
  if (sizeMode === "all_size" && sizes.some((size) => size !== "ALLSIZE")) {
    throw new FieldError("sizes", "Produk ini menggunakan All Size, bukan ukuran XS-XL.");
  }
}

export interface AddVariantsSelection {
  fabricColorId: string;
  sizes: readonly Size[];
}

export interface AddVariantsInput {
  productId: string;
  /** One or more colors, each with its own size list — all created in a SINGLE transaction (all
   * or nothing). Letting the caller batch multiple colors into one call is what makes a
   * multi-color "Tambah varian" submission atomic instead of one addVariants call per color. */
  selections: readonly AddVariantsSelection[];
}

/** Creates one product_variants row per requested size for every selection, atomically: if any
 * selection fails validation, or any row collides with an existing one, NOTHING is inserted —
 * there is no partial-success state to reconcile client-side. The SKU is built from each color's
 * NAME at this exact moment (see catalog/codes.ts) and stays immutable even if the color is
 * renamed later. The app-level `validateSizesForMode`/fabric-match/active/uniqueness checks run
 * first for friendly, pinpointed errors; `enforce_variant_size_mode` and the composite FKs
 * (migration 0004/0006/0007) are the actual DB-level guarantees behind them either way. */
export async function addVariants(input: AddVariantsInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    if (input.selections.length === 0) throw new FieldError("fabricColorId", "Pilih minimal satu warna.");
    // FOR UPDATE — see lockProductForUpdate's doc comment; serializes against updateProduct's
    // own fabric/closure change on this same product row.
    const product = await lockProductForUpdate(tx, input.productId);
    if (!product) throw new ActionError("Produk tidak ditemukan.");

    const rows: (typeof productVariants.$inferInsert)[] = [];
    for (const selection of input.selections) {
      validateSizesForMode(product.sizeMode, selection.sizes);

      const [color] = await tx.select().from(fabricColors).where(eq(fabricColors.id, selection.fabricColorId)).limit(1);
      if (!color) throw new ActionError("Warna tidak ditemukan.");
      if (color.fabricId !== product.fabricId) {
        // Friendly pre-check — the composite FK (fabric_color_id, fabric_id) ->
        // fabric_colors(id, fabric_id) is the actual guarantee, this just avoids a raw constraint
        // error for a mistake the UI shouldn't even offer (the color picker is scoped to the
        // product's own fabric), but a direct action call could still hit this.
        throw new FieldError("fabricColorId", `Warna "${color.name}" bukan milik bahan produk ini.`);
      }
      // Unlike the fabric-ownership check above, this one has no DB-level backstop — a
      // concurrent setFabricColorActive(id, false) landing between this read and the insert
      // below could still let a variant attach to an already-deactivated color. Accepted: this
      // is a low-concurrency, single-operator admin tool, and the (rare) result is merely a
      // stale-looking active variant on a deactivated color, not a data-integrity break —
      // deactivating a color never needs to retroactively invalidate variants that already
      // reference it.
      if (!color.isActive) {
        throw new FieldError("fabricColorId", `Warna "${color.name}" sudah dinonaktifkan dan tidak bisa dipakai untuk varian baru.`);
      }

      // New variants are always created ACTIVE, photo or not: production batches, stock counts
      // and orders all need an active SKU long before a photo exists. A photo-less color only
      // gets a "Belum ada foto" reminder badge in admin, and the storefront falls back to the
      // product's other photos (or a placeholder) for it.
      for (const size of selection.sizes) {
        rows.push({
          sku: generateSku({ code: product.code, closure: product.closure, color: color.name, size }),
          productId: product.id,
          fabricId: product.fabricId,
          fabricColorId: color.id,
          closure: product.closure,
          size,
          isActive: true,
        });
      }
    }

    // Advisory pre-check, same reasoning as the fabric-ownership/active checks above: the unique
    // constraint (product_id, fabric_color_id, size) below is the actual guarantee, but by the
    // time a raw 23505 reaches the catch block there's no way to say WHICH color+size in the
    // batch collided without parsing the driver's error detail string. Checking here, before the
    // insert, lets the error name the exact row.
    const existingRows = await tx
      .select({ fabricColorId: productVariants.fabricColorId, size: productVariants.size })
      .from(productVariants)
      .where(eq(productVariants.productId, product.id));
    const existingKeys = new Set(existingRows.map((row) => `${row.fabricColorId}:${row.size}`));
    const colorNameById = new Map(
      await tx
        .select({ id: fabricColors.id, name: fabricColors.name })
        .from(fabricColors)
        .where(eq(fabricColors.fabricId, product.fabricId))
        .then((colors) => colors.map((color) => [color.id, color.name] as const)),
    );
    for (const row of rows) {
      if (existingKeys.has(`${row.fabricColorId}:${row.size}`)) {
        const colorName = colorNameById.get(row.fabricColorId) ?? row.fabricColorId;
        throw new FieldError("fabricColorId", `Warna "${colorName}": ukuran ${sizeLabel(row.size)} sudah ada untuk produk ini.`);
      }
    }

    try {
      const created = await tx.insert(productVariants).values(rows).returning();
      // ONE audit_log entry for the whole batch, not one per variant — this is a single user
      // action ("Tambah varian"), and the created SKUs are listed in `after` for traceability.
      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "create",
        entityType: "product_variant",
        entityId: product.id,
        after: { skus: created.map((variant) => variant.sku) },
      });
      return { created };
    } catch (error) {
      // Defensive, not an active race: lockProductForUpdate's FOR UPDATE above already
      // serializes addVariants against updateProduct's own fabric/closure change on the same
      // product row, so this 23503 shouldn't actually fire from that race anymore. Kept as a
      // backstop (and for the friendly message) in case some other path ever updates
      // products.fabric_id/closure without going through updateProduct's lock.
      if (isPostgresErrorCode(error, "23503")) {
        throw new FieldError("fabricColorId", "Bahan produk ini berubah sebelum varian disimpan. Muat ulang halaman dan coba lagi.");
      }
      mapUniqueViolation(error, {
        product_variants_pkey: {
          field: "fabricColorId",
          message: "Kombinasi warna dan ukuran ini menghasilkan SKU yang sama dengan varian lain.",
        },
        product_variants_product_color_size_key: {
          field: "fabricColorId",
          message: "Warna dan ukuran ini sudah ada untuk produk ini. Mungkin dibuat bersamaan di tab lain.",
        },
      });
    }
  });
}

export interface UpdateVariantInput {
  sku: string;
  priceOverrideAmount?: number | null;
  minStockQty: number;
}

export interface BulkUpdateVariantsInput {
  productId: string;
  updates: UpdateVariantInput[];
}

/** Saves every edited variant row of one color group in a single transaction with ONE
 * audit_log entry (not one per row) — the group's "Simpan perubahan" button calls this exactly
 * once per save, not once per dirty row. Any row that fails (not found, or doesn't belong to
 * `productId`) rolls back every other update in the same call, so a save is all-or-nothing:
 * there's no state where some rows of a group saved and others didn't. */
export async function updateVariantsBulk(input: BulkUpdateVariantsInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const befores: (typeof productVariants.$inferSelect)[] = [];
    const afters: (typeof productVariants.$inferSelect)[] = [];
    for (const update of input.updates) {
      const [before] = await tx
        .select()
        .from(productVariants)
        .where(and(eq(productVariants.sku, update.sku), eq(productVariants.productId, input.productId)))
        .limit(1);
      if (!before) throw new ActionError(`Varian ${update.sku} tidak ditemukan.`);
      const [after] = await tx
        .update(productVariants)
        .set({ priceOverrideAmount: update.priceOverrideAmount ?? null, minStockQty: update.minStockQty })
        .where(eq(productVariants.sku, update.sku))
        .returning();
      if (!after) throw new Error("failed to update variant");
      befores.push(before);
      afters.push(after);
    }
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "bulk_update",
      entityType: "product_variant",
      entityId: input.productId,
      before: befores,
      after: afters,
    });
    return afters;
  });
}

export async function setVariantActive(
  sku: string,
  isActive: boolean,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    // Activating never depends on photos (see addVariants' comment) — a plain flag flip.
    const [before] = await tx.select().from(productVariants).where(eq(productVariants.sku, sku)).limit(1);
    if (!before) throw new ActionError("Varian tidak ditemukan.");

    const [after] = await tx
      .update(productVariants)
      .set({ isActive })
      .where(eq(productVariants.sku, sku))
      .returning();
    if (!after) throw new Error("failed to update variant");
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: isActive ? "activate" : "deactivate",
      entityType: "product_variant",
      entityId: sku,
      before,
      after,
    });
    return after;
  });
}

// ---------- Cost assumptions (Batas HPP) ----------

export async function getCurrentCostAssumption(db: Database = defaultDb, asOf: string = todayInJakarta()) {
  const [row] = await db
    .select()
    .from(costAssumptions)
    .where(lte(costAssumptions.effectiveFrom, asOf))
    .orderBy(desc(costAssumptions.effectiveFrom))
    .limit(1);
  return row ?? null;
}
