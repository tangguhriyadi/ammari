import "server-only";
import { asc, count, desc, eq } from "drizzle-orm";
import { products, productTypes } from "@ammari/db/schema";
import { ActionError, FieldError, mapUniqueViolation } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { isProductTypeCode } from "./codes";

// Both are enforced by constraints (migration 0037), never a "does this exist yet" SELECT first
// (CLAUDE.md): this map only runs after an insert/update already failed on one of them.
const PRODUCT_TYPE_CONSTRAINT_FIELDS = {
  product_types_pkey: { field: "code", message: "Kode jenis produk ini sudah dipakai." },
  product_types_name_unique: { field: "name", message: "Nama jenis produk ini sudah dipakai." },
};

export type ProductTypeRow = typeof productTypes.$inferSelect;

export interface ProductTypeListRow {
  code: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  /** How many products use this type, active or not. */
  productCount: number;
}

/** The full master list (active and inactive) for the management page, in display order.
 * Small reference data, so no pagination (same as cost components). */
export async function listProductTypes(db: Database = defaultDb): Promise<ProductTypeListRow[]> {
  return db
    .select({
      code: productTypes.code,
      name: productTypes.name,
      isActive: productTypes.isActive,
      sortOrder: productTypes.sortOrder,
      productCount: count(products.id),
    })
    .from(productTypes)
    .leftJoin(products, eq(products.productTypeCode, productTypes.code))
    .groupBy(productTypes.code)
    .orderBy(asc(productTypes.sortOrder), asc(productTypes.name), asc(productTypes.code));
}

export async function getProductTypeByCode(code: string, db: Database = defaultDb): Promise<ProductTypeRow | null> {
  if (!isProductTypeCode(code)) return null;
  const [row] = await db.select().from(productTypes).where(eq(productTypes.code, code)).limit(1);
  return row ?? null;
}

/** FOR UPDATE, so the audit log's `before` is exactly the row the UPDATE replaces. */
async function lockProductTypeForUpdate(tx: Tx, code: string): Promise<ProductTypeRow | null> {
  if (!isProductTypeCode(code)) return null;
  const [row] = await tx.select().from(productTypes).where(eq(productTypes.code, code)).for("update");
  return row ?? null;
}

export interface CreateProductTypeInput {
  /** Already trimmed and uppercased by the caller's schema. */
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

/** No `code`: it's immutable once created (prevent_product_type_code_change trigger). */
export interface UpdateProductTypeInput {
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export async function createProductType(input: CreateProductTypeInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    try {
      const [created] = await tx.insert(productTypes).values(input).returning();
      if (!created) throw new Error("failed to insert product type");
      await writeAuditLog(tx, { actorStaffUserId, action: "create", entityType: "product_type", entityId: created.code, after: created });
      return created;
    } catch (error) {
      mapUniqueViolation(error, PRODUCT_TYPE_CONSTRAINT_FIELDS);
    }
  });
}

export async function updateProductType(
  code: string,
  input: UpdateProductTypeInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    const before = await lockProductTypeForUpdate(tx, code);
    if (!before) throw new ActionError("Jenis produk tidak ditemukan.");
    try {
      const [after] = await tx
        .update(productTypes)
        .set({ name: input.name, sortOrder: input.sortOrder, isActive: input.isActive })
        .where(eq(productTypes.code, code))
        .returning();
      if (!after) throw new Error("failed to update product type");
      await writeAuditLog(tx, { actorStaffUserId, action: "update", entityType: "product_type", entityId: code, before, after });
      return after;
    } catch (error) {
      mapUniqueViolation(error, PRODUCT_TYPE_CONSTRAINT_FIELDS);
    }
  });
}

/** No hard delete, ever (owner decision): "Nonaktifkan" is this. An inactive type can't be picked
 * for a new product or a type change, but stays on the products that already use it. */
export async function setProductTypeActive(code: string, isActive: boolean, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const before = await lockProductTypeForUpdate(tx, code);
    if (!before) throw new ActionError("Jenis produk tidak ditemukan.");
    const [after] = await tx.update(productTypes).set({ isActive }).where(eq(productTypes.code, code)).returning();
    if (!after) throw new Error("failed to update product type");
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: isActive ? "activate" : "deactivate",
      entityType: "product_type",
      entityId: code,
      before,
      after,
    });
    return after;
  });
}

// ---------- Picker and filter support ----------

export interface ProductTypeOption {
  code: string;
  name: string;
}

/** ACTIVE types only, in display order — the product form's option list. A product whose type was
 * deactivated later gets it added back as its own current value by the caller. */
export async function listActiveProductTypeOptions(db: Database = defaultDb): Promise<ProductTypeOption[]> {
  return db
    .select({ code: productTypes.code, name: productTypes.name })
    .from(productTypes)
    .where(eq(productTypes.isActive, true))
    .orderBy(asc(productTypes.sortOrder), asc(productTypes.name), asc(productTypes.code));
}

/** EVERY type, inactive included (they sort last), for the product list's read-only filter:
 * products still carry a type that has since been deactivated. Never use this for a picker. */
export async function listProductTypeFilterOptions(db: Database = defaultDb): Promise<(ProductTypeOption & { isActive: boolean })[]> {
  return db
    .select({ code: productTypes.code, name: productTypes.name, isActive: productTypes.isActive })
    .from(productTypes)
    .orderBy(desc(productTypes.isActive), asc(productTypes.sortOrder), asc(productTypes.name), asc(productTypes.code));
}

/** For a write that is about to point a product at `code` as a NEW selection: `SELECT ... FOR
 * SHARE` the row and reject (field-scoped, Indonesian) a type that doesn't exist or is inactive.
 * FOR SHARE so a concurrent setProductTypeActive(code, false) (an UPDATE, which needs a
 * conflicting row lock) waits for this transaction instead of slipping in between this check and
 * the caller's own write — same shape as lockSelectableSuppliers. */
export async function lockSelectableProductType(tx: Tx, code: string, field = "productTypeCode"): Promise<ProductTypeOption> {
  if (!isProductTypeCode(code)) throw new FieldError(field, "Pilih jenis produk.");
  const [row] = await tx
    .select({ code: productTypes.code, name: productTypes.name, isActive: productTypes.isActive })
    .from(productTypes)
    .where(eq(productTypes.code, code))
    .for("share");
  if (!row) throw new FieldError(field, "Jenis produk tidak ditemukan.");
  if (!row.isActive) throw new FieldError(field, `Jenis produk "${row.name}" sudah dinonaktifkan dan tidak bisa dipilih lagi.`);
  return { code: row.code, name: row.name };
}
