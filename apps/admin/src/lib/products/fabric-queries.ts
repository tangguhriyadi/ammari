import "server-only";
import { and, count, eq, ilike } from "drizzle-orm";
import { fabricColors, fabrics, productImages, productVariants, products } from "@ammari/db/schema";
import type { FabricPriceUnit } from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { normalizeColorHex } from "./color-hex";
import { ActionError, FieldError, isPostgresErrorCode, mapUniqueViolation } from "./errors";
import { defaultDb, writeAuditLog, type Database } from "./db";

const FABRIC_CONSTRAINT_FIELDS = {} as const;

const FABRIC_COLOR_CONSTRAINT_FIELDS = {
  fabric_colors_fabric_id_name_key: { field: "name", message: "Warna ini sudah ada untuk bahan ini." },
};

// ---------- Fabrics ----------

export interface FabricInput {
  name: string;
  supplier?: string | null;
  composition?: string | null;
  priceAmount?: number | null;
  priceUnit?: FabricPriceUnit | null;
  careInstructions?: string | null;
  notes?: string | null;
}

export async function listFabricsWithUsage(
  q: string | undefined,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: Awaited<ReturnType<typeof queryFabricsPage>>; pagination: Pagination }> {
  const where = q ? ilike(fabrics.name, `%${q}%`) : undefined;

  const [totalCountRow] = await db
    .select({ totalCount: count() })
    .from(fabrics)
    .where(where);

  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });
  const rows = await queryFabricsPage(db, where, pagination);
  return { rows, pagination };
}

function queryFabricsPage(db: Database, where: ReturnType<typeof ilike> | undefined, pagination: Pagination) {
  return db
    .select({
      id: fabrics.id,
      name: fabrics.name,
      supplier: fabrics.supplier,
      composition: fabrics.composition,
      priceAmount: fabrics.priceAmount,
      priceUnit: fabrics.priceUnit,
      careInstructions: fabrics.careInstructions,
      notes: fabrics.notes,
      productCount: count(products.id),
    })
    .from(fabrics)
    .leftJoin(products, eq(products.fabricId, fabrics.id))
    .where(where)
    .groupBy(fabrics.id)
    .orderBy(fabrics.name, fabrics.id)
    .limit(pagination.limit)
    .offset(pagination.offset);
}

export async function getFabricById(id: string, db: Database = defaultDb) {
  const [fabric] = await db.select().from(fabrics).where(eq(fabrics.id, id)).limit(1);
  return fabric ?? null;
}

/** Fabrics have no `is_active` flag (unlike accessories) — every fabric is always a valid
 * purchase target, so this is simply every fabric, ordered for a picker. */
export async function listActiveFabrics(db: Database = defaultDb) {
  return db.select().from(fabrics).orderBy(fabrics.name);
}

export async function getFabricUsageCount(id: string, db: Database = defaultDb): Promise<number> {
  const [row] = await db.select({ usedByCount: count() }).from(products).where(eq(products.fabricId, id));
  return row?.usedByCount ?? 0;
}

/** Fabric colors also hold an `ON DELETE RESTRICT` FK to `fabrics` (independent of whether any
 * product uses the fabric yet) — a fabric with colors but zero products would otherwise pass
 * `getFabricUsageCount`'s check and then fail the real DELETE with a 23503 the catch below
 * can't attribute correctly. Checked separately so the advisory message names the right blocker. */
async function getFabricColorCount(id: string, db: Database = defaultDb): Promise<number> {
  const [row] = await db.select({ colorCount: count() }).from(fabricColors).where(eq(fabricColors.fabricId, id));
  return row?.colorCount ?? 0;
}

export async function createFabric(input: FabricInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    try {
      const [fabric] = await tx.insert(fabrics).values(input).returning();
      if (!fabric) throw new Error("failed to insert fabric");
      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "create",
        entityType: "fabric",
        entityId: fabric.id,
        after: fabric,
      });
      return fabric;
    } catch (error) {
      mapUniqueViolation(error, FABRIC_CONSTRAINT_FIELDS);
    }
  });
}

export async function updateFabric(
  id: string,
  input: FabricInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    const before = await getFabricById(id, tx);
    if (!before) throw new ActionError("Bahan tidak ditemukan.");
    try {
      const [after] = await tx.update(fabrics).set(input).where(eq(fabrics.id, id)).returning();
      if (!after) throw new Error("failed to update fabric");
      await writeAuditLog(tx, { actorStaffUserId, action: "update", entityType: "fabric", entityId: id, before, after });
      return after;
    } catch (error) {
      mapUniqueViolation(error, FABRIC_CONSTRAINT_FIELDS);
    }
  });
}

export async function deleteFabric(id: string, actorStaffUserId: string | null, db: Database = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await getFabricById(id, tx);
    if (!before) throw new ActionError("Bahan tidak ditemukan.");

    // Advisory only — not the safety mechanism. The FKs (products.fabric_id and
    // fabric_colors.fabric_id, both ON DELETE RESTRICT) are what actually guarantee a used fabric
    // can't be deleted; this just lets the error message say WHY, per the product spec's "show
    // why" requirement. Both referencing tables are checked — a fabric can have colors defined
    // before any product uses it, and that alone already blocks deletion. Rows added between
    // this check and the delete below just fall through to the FK violation catch — still
    // correctly refused, only with the generic message instead.
    const usedByCount = await getFabricUsageCount(id, tx);
    if (usedByCount > 0) {
      throw new ActionError(`Bahan ini masih dipakai oleh ${usedByCount} produk, tidak bisa dihapus.`, {
        usedByCount,
      });
    }
    const colorCount = await getFabricColorCount(id, tx);
    if (colorCount > 0) {
      throw new ActionError(`Bahan ini masih punya ${colorCount} warna, tidak bisa dihapus.`, { colorCount });
    }

    try {
      await tx.delete(fabrics).where(eq(fabrics.id, id));
    } catch (error) {
      // 23503 = foreign_key_violation. Only THIS specific failure is the expected "still in use"
      // race — anything else (connection drop, an unrelated bug) must surface as a real error.
      // The generic wording (not naming products or colors) is deliberate: by this point either
      // pre-check could have raced, so we can't say which one actually fired.
      if (isPostgresErrorCode(error, "23503")) {
        throw new ActionError("Bahan ini masih dipakai, tidak bisa dihapus.");
      }
      throw error;
    }
    await writeAuditLog(tx, { actorStaffUserId, action: "delete", entityType: "fabric", entityId: id, before });
  });
}

// ---------- Fabric colors ----------

export interface FabricColorInput {
  name: string;
  supplierColorCode?: string | null;
  hex?: string | null;
}

function normalizeFabricColorInput(input: FabricColorInput): { name: string; supplierColorCode: string | null; hex: string | null } {
  const normalizedHex = input.hex ? normalizeColorHex(input.hex) : null;
  if (input.hex && !normalizedHex) {
    throw new FieldError("hex", "Kode warna harus 6 digit, contoh #9CAF88. Untuk hitam: #000000.");
  }
  return { name: input.name.trim(), supplierColorCode: input.supplierColorCode || null, hex: normalizedHex };
}

/** A single row from the "Bahan baru" form's repeatable color editor — unlike {@link
 * FabricColorInput}, `name` is not required here: a row the user never touched at all (every
 * field blank) is silently dropped by {@link createFabricWithColors}, not a validation error. */
export interface FabricColorRowInput {
  name: string;
  supplierColorCode?: string | null;
  hex?: string | null;
}

function isBlankColorRow(row: FabricColorRowInput): boolean {
  return !row.name.trim() && !row.supplierColorCode?.trim() && !row.hex?.trim();
}

/** Creates a fabric and all of its initial colors in ONE transaction (all-or-nothing) with a
 * SINGLE audit_log entry — lets the "Bahan baru" form offer colors up front instead of forcing a
 * save-then-add-colors-separately flow. Every validation (missing name, invalid hex, duplicate
 * name within this submission) runs BEFORE the transaction starts, so a bad row never leaves a
 * half-created fabric behind — the caller gets a FieldError keyed `colors.<index>.<field>` so the
 * UI can show it next to the exact offending row. */
export async function createFabricWithColors(
  fabricInput: FabricInput,
  colorRows: readonly FabricColorRowInput[],
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  const normalizedColors = colorRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !isBlankColorRow(row))
    .map(({ row, index }) => {
      if (!row.name.trim()) throw new FieldError(`colors.${index}.name`, "Nama warna wajib diisi.");
      try {
        return { index, ...normalizeFabricColorInput(row) };
      } catch (error) {
        if (error instanceof FieldError) throw new FieldError(`colors.${index}.${error.field}`, error.message);
        throw error;
      }
    });

  // Case-insensitive duplicate-name check WITHIN this submission. The citext unique constraint
  // (fabric_colors_fabric_id_name_key) is still the real guarantee — enforced below, after the
  // insert — but for a brand-new fabric the ONLY way that constraint could fire is a bug in THIS
  // check (there's no pre-existing fabric_colors row to race against yet), so checking here first
  // is what lets the error point at the right row instead of an arbitrary one.
  const firstIndexByName = new Map<string, number>();
  for (const color of normalizedColors) {
    const key = color.name.toLowerCase();
    const firstIndex = firstIndexByName.get(key);
    if (firstIndex !== undefined) {
      throw new FieldError(`colors.${color.index}.name`, `Nama warna ini sudah dipakai di baris ${firstIndex + 1}.`);
    }
    firstIndexByName.set(key, color.index);
  }

  return db.transaction(async (tx) => {
    let fabric: typeof fabrics.$inferSelect | undefined;
    try {
      [fabric] = await tx.insert(fabrics).values(fabricInput).returning();
    } catch (error) {
      mapUniqueViolation(error, FABRIC_CONSTRAINT_FIELDS);
    }
    if (!fabric) throw new Error("failed to insert fabric");
    const fabricId = fabric.id;

    let createdColors: (typeof fabricColors.$inferSelect)[] = [];
    if (normalizedColors.length > 0) {
      try {
        createdColors = await tx
          .insert(fabricColors)
          .values(normalizedColors.map(({ name, supplierColorCode, hex }) => ({ fabricId, name, supplierColorCode, hex })))
          .returning();
      } catch (error) {
        // Defensive only — see the duplicate-name check above: a brand-new fabric can't already
        // have a colliding fabric_colors row on the NAME constraint, so reaching this means that
        // check itself had a bug. Only maps that specific constraint, though — fabric_colors also
        // has a second unique constraint, (id, fabric_id) (needed for product_variants' composite
        // FK), which this pre-check says nothing about; a violation of THAT one (e.g. a
        // gen_random_uuid() collision) is a genuinely different, unrelated failure and must not be
        // mis-reported as "duplicate color name".
        mapUniqueViolation(error, {
          fabric_colors_fabric_id_name_key: {
            field: "colors.0.name",
            message: "Salah satu warna pada formulir ini sudah ada untuk bahan ini.",
          },
        });
      }
    }

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "create",
      entityType: "fabric",
      entityId: fabric.id,
      after: { ...fabric, colors: createdColors },
    });

    return { fabric, colors: createdColors };
  });
}

export async function listFabricColors(
  fabricId: string,
  options: { activeOnly?: boolean } = {},
  db: Database = defaultDb,
) {
  return db
    .select()
    .from(fabricColors)
    .where(
      options.activeOnly
        ? and(eq(fabricColors.fabricId, fabricId), eq(fabricColors.isActive, true))
        : eq(fabricColors.fabricId, fabricId),
    )
    .orderBy(fabricColors.name);
}

export async function getFabricColorById(id: string, db: Database = defaultDb) {
  const [color] = await db.select().from(fabricColors).where(eq(fabricColors.id, id)).limit(1);
  return color ?? null;
}

export async function getFabricColorUsageCount(id: string, db: Database = defaultDb): Promise<number> {
  const [row] = await db.select({ usedByCount: count() }).from(productVariants).where(eq(productVariants.fabricColorId, id));
  return row?.usedByCount ?? 0;
}

/** Product images also hold an `ON DELETE RESTRICT` FK to `fabric_colors`, independent of
 * whether any variant uses the color — a color referenced only by an image would otherwise pass
 * `getFabricColorUsageCount`'s check and then fail the real DELETE with a 23503 the catch below
 * can't attribute correctly. Checked separately so the advisory message names the right blocker. */
async function getFabricColorImageCount(id: string, db: Database = defaultDb): Promise<number> {
  const [row] = await db.select({ imageCount: count() }).from(productImages).where(eq(productImages.fabricColorId, id));
  return row?.imageCount ?? 0;
}

export async function createFabricColor(
  fabricId: string,
  input: FabricColorInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  const values = normalizeFabricColorInput(input);
  return db.transaction(async (tx) => {
    try {
      const [color] = await tx.insert(fabricColors).values({ fabricId, ...values }).returning();
      if (!color) throw new Error("failed to insert fabric color");
      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "create",
        entityType: "fabric_color",
        entityId: color.id,
        after: color,
      });
      return color;
    } catch (error) {
      mapUniqueViolation(error, FABRIC_COLOR_CONSTRAINT_FIELDS);
    }
  });
}

export async function updateFabricColor(
  id: string,
  input: FabricColorInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  const values = normalizeFabricColorInput(input);
  return db.transaction(async (tx) => {
    const before = await getFabricColorById(id, tx);
    if (!before) throw new ActionError("Warna tidak ditemukan.");
    try {
      const [after] = await tx.update(fabricColors).set(values).where(eq(fabricColors.id, id)).returning();
      if (!after) throw new Error("failed to update fabric color");
      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "update",
        entityType: "fabric_color",
        entityId: id,
        before,
        after,
      });
      return after;
    } catch (error) {
      mapUniqueViolation(error, FABRIC_COLOR_CONSTRAINT_FIELDS);
    }
  });
}

export async function setFabricColorActive(
  id: string,
  isActive: boolean,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    const before = await getFabricColorById(id, tx);
    if (!before) throw new ActionError("Warna tidak ditemukan.");
    const [after] = await tx.update(fabricColors).set({ isActive }).where(eq(fabricColors.id, id)).returning();
    if (!after) throw new Error("failed to update fabric color");
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: isActive ? "activate" : "deactivate",
      entityType: "fabric_color",
      entityId: id,
      before,
      after,
    });
    return after;
  });
}

export async function deleteFabricColor(id: string, actorStaffUserId: string | null, db: Database = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await getFabricColorById(id, tx);
    if (!before) throw new ActionError("Warna tidak ditemukan.");

    // Advisory only, same reasoning as deleteFabric above — the FKs are the real guarantee. Both
    // referencing tables (variants AND images) are checked; a color can be attached to a product
    // image before any variant uses it.
    const usedByCount = await getFabricColorUsageCount(id, tx);
    if (usedByCount > 0) {
      throw new ActionError(`Warna ini masih dipakai oleh ${usedByCount} varian, tidak bisa dihapus.`, { usedByCount });
    }
    const imageCount = await getFabricColorImageCount(id, tx);
    if (imageCount > 0) {
      throw new ActionError(`Warna ini masih dipakai oleh ${imageCount} gambar produk, tidak bisa dihapus.`, { imageCount });
    }

    try {
      await tx.delete(fabricColors).where(eq(fabricColors.id, id));
    } catch (error) {
      // The generic wording (not naming variants or images) is deliberate — see deleteFabric.
      if (isPostgresErrorCode(error, "23503")) {
        throw new ActionError("Warna ini masih dipakai, tidak bisa dihapus.");
      }
      throw error;
    }
    await writeAuditLog(tx, { actorStaffUserId, action: "delete", entityType: "fabric_color", entityId: id, before });
  });
}
