import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { suppliers } from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { ActionError, FieldError, mapUniqueViolation } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import type { SupplierKind } from "./kinds";

// `suppliers.name` is citext UNIQUE (migration 0022), so "Laksmi" and "laksmi" collide — the
// constraint is the source of truth and this map only runs AFTER an insert/update has already
// failed on it. Never a "does this name exist yet" SELECT first (CLAUDE.md): two people adding
// the same supplier at the same moment would both see "no" and both insert.
const SUPPLIER_CONSTRAINT_FIELDS = {
  suppliers_name_unique: {
    field: "name",
    message: "Nama supplier ini sudah terdaftar.",
  },
};

/** Already trimmed and validated by the caller (the server action's Zod schema, which is also
 * what guarantees `kinds` only ever holds SUPPLIER_KINDS values and no duplicates) — this layer
 * passes it straight through to the columns, same contract lib/products/queries.ts's
 * ProductInput.highlights documents. The DB CHECKs behind `kinds` are the backstop, not the
 * validation. */
export interface SupplierInput {
  name: string;
  kinds?: string[];
  phone?: string | null;
  address?: string | null;
  bankName?: string | null;
  bankAccountNo?: string | null;
  bankAccountName?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export type SupplierActiveFilter = "active" | "inactive" | undefined;

export type SupplierRow = typeof suppliers.$inferSelect;

/** Nothing on this table is cost/profit data, so unlike listAccessories there is nothing for the
 * caller to strip before rendering for a session without `finance.view_profit` — bank details
 * are payment reference text the whole `inventory.view` audience needs. */
export async function listSuppliers(
  filters: { q?: string; activeFilter?: SupplierActiveFilter },
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: SupplierRow[]; pagination: Pagination }> {
  const conditions = [
    filters.q ? ilike(suppliers.name, `%${filters.q}%`) : undefined,
    filters.activeFilter === "active" ? eq(suppliers.isActive, true) : undefined,
    filters.activeFilter === "inactive" ? eq(suppliers.isActive, false) : undefined,
  ].filter((condition) => condition !== undefined);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalCountRow] = await db.select({ totalCount: count() }).from(suppliers).where(where);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });

  const rows = await db
    .select()
    .from(suppliers)
    .where(where)
    // (name, id): name alone isn't unique-by-sort for pagination purposes in general — the id
    // tiebreak keeps page 2 from repeating or skipping a row, same ordering every other
    // paginated list in this codebase uses.
    .orderBy(suppliers.name, suppliers.id)
    .limit(pagination.limit)
    .offset(pagination.offset);

  return { rows, pagination };
}

/** Postgres rejects a non-UUID string in a `where id = $1` comparison outright (22P02,
 * "invalid input syntax for type uuid"), which would surface as a 500 for a hand-typed URL like
 * `/suppliers/abc` instead of the 404 the page means to render. Checked here, once, rather than
 * at every call site. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSupplierId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export async function getSupplierById(id: string, db: Database = defaultDb): Promise<SupplierRow | null> {
  if (!isSupplierId(id)) return null;
  const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  return row ?? null;
}

export async function createSupplier(input: SupplierInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    try {
      const [supplier] = await tx.insert(suppliers).values(input).returning();
      if (!supplier) throw new Error("failed to insert supplier");
      await writeAuditLog(tx, { actorStaffUserId, action: "create", entityType: "supplier", entityId: supplier.id, after: supplier });
      return supplier;
    } catch (error) {
      mapUniqueViolation(error, SUPPLIER_CONSTRAINT_FIELDS);
    }
  });
}

export async function updateSupplier(id: string, input: SupplierInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const before = await getSupplierById(id, tx);
    if (!before) throw new ActionError("Supplier tidak ditemukan.");
    try {
      const [after] = await tx.update(suppliers).set(input).where(eq(suppliers.id, id)).returning();
      if (!after) throw new Error("failed to update supplier");
      await writeAuditLog(tx, { actorStaffUserId, action: "update", entityType: "supplier", entityId: id, before, after });
      return after;
    } catch (error) {
      mapUniqueViolation(error, SUPPLIER_CONSTRAINT_FIELDS);
    }
  });
}

/** No hard delete, ever — same reasoning as accessories/cost_components/fabric_colors: the
 * purchase and cost-line FKs that later sessions point at this table are ON DELETE RESTRICT, so
 * a referenced supplier could not be removed anyway, and an unreferenced one still carries the
 * bank details she'd have to retype. "Hapus" in the UI is always this. */
export async function setSupplierActive(id: string, isActive: boolean, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const before = await getSupplierById(id, tx);
    if (!before) throw new ActionError("Supplier tidak ditemukan.");
    const [after] = await tx.update(suppliers).set({ isActive }).where(eq(suppliers.id, id)).returning();
    if (!after) throw new Error("failed to update supplier");
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: isActive ? "activate" : "deactivate",
      entityType: "supplier",
      entityId: id,
      before,
      after,
    });
    return after;
  });
}

// ---------- Picker support (cost components, batch cost lines) ----------

export interface SupplierOption {
  id: string;
  name: string;
}

/** ACTIVE suppliers only, as a picker's option list — an inactive supplier must never be offered
 * for a NEW selection (it still displays on the records that already reference it; those callers
 * add it back as their own current value). `kinds` is a SOFT filter (plan D13): suppliers tagged
 * with `preferredKind` sort first, everyone else still follows, nobody is hidden. Only id + name
 * leave this function: the picker needs nothing else, and the bank/contact columns have no
 * business on a cost-component or production page. */
export async function listActiveSupplierOptions(
  preferredKind: SupplierKind | undefined,
  db: Database = defaultDb,
): Promise<SupplierOption[]> {
  const preferredFirst = preferredKind ? [desc(sql`${preferredKind} = any(${suppliers.kinds})`)] : [];
  return db
    .select({ id: suppliers.id, name: suppliers.name })
    .from(suppliers)
    .where(eq(suppliers.isActive, true))
    .orderBy(...preferredFirst, asc(suppliers.name), asc(suppliers.id));
}

/** EVERY supplier, inactive included, for a read-only list FILTER (e.g. /receipts): past
 * documents still name a supplier that has since been deactivated. Never use this for a picker
 * that writes (that is listActiveSupplierOptions). */
export async function listSupplierFilterOptions(db: Database = defaultDb): Promise<(SupplierOption & { isActive: boolean })[]> {
  return db
    .select({ id: suppliers.id, name: suppliers.name, isActive: suppliers.isActive })
    .from(suppliers)
    .orderBy(desc(suppliers.isActive), asc(suppliers.name), asc(suppliers.id));
}

/** For a write that is about to point a row at one or more suppliers as a NEW selection:
 * `SELECT ... FOR SHARE` every id, and reject (field-scoped, Indonesian) any that doesn't exist
 * or is inactive. FOR SHARE, not a plain read, so a concurrent setSupplierActive(id, false)
 * (an UPDATE, which needs a conflicting row lock) blocks until this transaction commits instead
 * of slipping in between this check and the caller's own INSERT/UPDATE: the check and the write
 * see the same supplier state. Only meaningful inside a real transaction. Returns the locked rows
 * by id, so the caller can snapshot each supplier's CURRENT name from the same read. */
export async function lockSelectableSuppliers(
  tx: Tx,
  ids: readonly string[],
  field: string,
): Promise<Map<string, SupplierOption>> {
  const uniqueIds = [...new Set(ids)].sort();
  if (uniqueIds.length === 0) return new Map();
  for (const id of uniqueIds) {
    if (!isSupplierId(id)) throw new FieldError(field, "Supplier tidak ditemukan.");
  }
  const rows = await tx
    .select({ id: suppliers.id, name: suppliers.name, isActive: suppliers.isActive })
    .from(suppliers)
    .where(inArray(suppliers.id, uniqueIds))
    .orderBy(suppliers.id)
    .for("share");
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of uniqueIds) {
    const row = byId.get(id);
    if (!row) throw new FieldError(field, "Supplier tidak ditemukan.");
    if (!row.isActive) {
      throw new FieldError(field, `Supplier "${row.name}" sudah dinonaktifkan dan tidak bisa dipilih lagi.`);
    }
  }
  return new Map(rows.map((row) => [row.id, { id: row.id, name: row.name }]));
}
