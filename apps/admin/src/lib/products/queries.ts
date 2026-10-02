import "server-only";
import { and, count, desc, eq, ilike, lte } from "drizzle-orm";
import { costAssumptions, fabricColors, fabrics, products, productVariants } from "@ammari/db/schema";
import type { ProductClosure, Size, SizeMode } from "@ammari/db/schema";
import { generateSku } from "@ammari/db/catalog";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { ActionError, FieldError, isPostgresErrorCode, mapUniqueViolation } from "./errors";
import { todayInJakarta } from "./jakarta-date";
import { defaultDb, writeAuditLog, type Database } from "./db";

const PAGE_SIZE = 20;

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
}

export interface UpdateProductInput {
  name: string;
  slug: string;
  fabricId: string;
  closure: ProductClosure;
  basePrice: number;
  description?: string | null;
  isActive: boolean;
}

export async function listProducts(
  q: string | undefined,
  rawPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: Awaited<ReturnType<typeof queryProductsPage>>; pagination: Pagination }> {
  const where = q ? ilike(products.name, `%${q}%`) : undefined;

  const [totalCountRow] = await db
    .select({ totalCount: count() })
    .from(products)
    .where(where);

  const pagination = resolvePagination({ rawPage, totalCount: totalCountRow?.totalCount ?? 0, pageSize: PAGE_SIZE });
  const rows = await queryProductsPage(db, where, pagination);
  return { rows, pagination };
}

function queryProductsPage(db: Database, where: ReturnType<typeof ilike> | undefined, pagination: Pagination) {
  return db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      closure: products.closure,
      basePrice: products.basePrice,
      isActive: products.isActive,
      fabricName: fabrics.name,
      activeVariantCount: count(productVariants.sku),
    })
    .from(products)
    .innerJoin(fabrics, eq(fabrics.id, products.fabricId))
    .leftJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isActive, true)))
    .where(where)
    .groupBy(products.id, fabrics.name)
    .orderBy(products.name, products.id)
    .limit(pagination.limit)
    .offset(pagination.offset);
}

export async function getProductById(id: string, db: Database = defaultDb) {
  const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  return product ?? null;
}

export async function getVariantCount(productId: string, db: Database = defaultDb): Promise<number> {
  const [row] = await db.select({ total: count() }).from(productVariants).where(eq(productVariants.productId, productId));
  return row?.total ?? 0;
}

export async function getProductDetail(id: string, db: Database = defaultDb) {
  const product = await getProductById(id, db);
  if (!product) return null;
  const [fabric] = await db.select().from(fabrics).where(eq(fabrics.id, product.fabricId)).limit(1);
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
  return { product, fabric: fabric ?? null, variants };
}

export async function createProduct(
  input: CreateProductInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
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
    const before = await getProductById(id, tx);
    if (!before) throw new ActionError("Produk tidak ditemukan.");

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
    const product = await getProductById(input.productId, tx);
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

      for (const size of selection.sizes) {
        rows.push({
          sku: generateSku({ code: product.code, closure: product.closure, color: color.name, size }),
          productId: product.id,
          fabricId: product.fabricId,
          fabricColorId: color.id,
          closure: product.closure,
          size,
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
        throw new FieldError("fabricColorId", `Warna "${colorName}": ukuran ${row.size} sudah ada untuk produk ini.`);
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
      return created;
    } catch (error) {
      // 23503 here means the product's fabric or closure was changed concurrently, between the
      // reads above and this INSERT (the mirror-image race of updateProduct's — the same
      // composite FK catches it from the other side).
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
          message: "Warna dan ukuran ini sudah ada untuk produk ini — mungkin dibuat bersamaan di tab lain.",
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

export async function updateVariant(input: UpdateVariantInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(productVariants).where(eq(productVariants.sku, input.sku)).limit(1);
    if (!before) throw new ActionError("Varian tidak ditemukan.");
    const [after] = await tx
      .update(productVariants)
      .set({ priceOverrideAmount: input.priceOverrideAmount ?? null, minStockQty: input.minStockQty })
      .where(eq(productVariants.sku, input.sku))
      .returning();
    if (!after) throw new Error("failed to update variant");
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "update",
      entityType: "product_variant",
      entityId: input.sku,
      before,
      after,
    });
    return after;
  });
}

export async function bulkSetMinStock(
  productId: string,
  minStockQty: number,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<number> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(productVariants)
      .set({ minStockQty })
      .where(and(eq(productVariants.productId, productId), eq(productVariants.isActive, true)))
      .returning({ sku: productVariants.sku });
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "bulk_update",
      entityType: "product_variant",
      entityId: productId,
      after: { minStockQty, affectedSkus: updated.map((row) => row.sku) },
    });
    return updated.length;
  });
}

export async function setVariantActive(
  sku: string,
  isActive: boolean,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
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
