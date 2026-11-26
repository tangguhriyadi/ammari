import "server-only";
import { cache } from "react";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  EXPENSE_CATEGORY_KINDS,
  RESERVED_EXPENSE_CATEGORY_CODE,
  RESERVED_EXPENSE_CATEGORY_NAME,
  businessExpenses,
  expenseCategories,
  expenseItems,
  type ChannelId,
  type ExpenseCategoryKind,
} from "@ammari/db/schema";
import { qualifiedColumn as q } from "@ammari/db/sql-helpers";
import { ActionError, FieldError, isPostgresErrorCode, mapUniqueViolation } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import type { ExpenseCategoryCatalog, ExpenseCategoryInfo, ExpenseItemInfo } from "./catalog";

// "Kategori Biaya" master data (docs/plans/expense-master-data.md §3.5, session S2): the catalog
// every expense figure, list and form reads instead of the old fixed code list, the category and
// item writes the Data Master pages (S3) will call, and the lock a new expense takes on its
// category and item. Same shape as lib/product-types/queries.ts. Callers check
// ads_expenses.manage + finance.view_profit (owner answer D5) before calling a write.

export const EXPENSE_CATEGORY_MESSAGES = {
  nameRequired: "Nama kategori wajib diisi.",
  nameTooLong: "Nama kategori maksimal 60 karakter.",
  nameTaken: "Nama kategori ini sudah dipakai.",
  nameReserved: `"${RESERVED_EXPENSE_CATEGORY_NAME}" dipakai untuk pengeluaran produksi dan tidak bisa jadi nama kategori.`,
  kind: "Pilih jenis: Iklan, Endorse, atau Operasional.",
  sortOrder: "Urutan harus bilangan bulat.",
  categoryNotFound: "Kategori biaya tidak ditemukan.",
  systemCannotDeactivate: "Kategori sistem dipakai perhitungan ROAS/laporan dan tidak bisa dinonaktifkan.",
  categoryRequired: "Pilih kategori.",
  categoryInactive: (name: string) => `Kategori "${name}" sudah dinonaktifkan dan tidak bisa dipilih lagi.`,
  itemNameRequired: "Nama item wajib diisi.",
  itemNameTooLong: "Nama item maksimal 80 karakter.",
  itemNameTaken: "Nama sudah dipakai di kategori ini.",
  itemNoteTooLong: "Catatan item maksimal 200 karakter.",
  itemDefaultAmount: "Jumlah default harus bilangan bulat lebih dari 0, maksimal Rp1.000.000.000.",
  itemNotFound: "Item biaya tidak ditemukan.",
  itemInactive: (name: string) => `Item "${name}" sudah dinonaktifkan dan tidak bisa dipilih lagi.`,
} as const;

const MAX_CATEGORY_NAME = 60;
const MAX_ITEM_NAME = 80;
const MAX_ITEM_NOTE = 200;
const MAX_DEFAULT_AMOUNT = 1_000_000_000;
/** expense_categories_code_check: ^[a-z][a-z0-9_]{0,39}$. */
const MAX_CODE_LENGTH = 40;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Enforced by constraints (migration 0048); this map only runs after a write already failed.
const CATEGORY_CONSTRAINT_FIELDS = {
  expense_categories_name_unique: { field: "name", message: EXPENSE_CATEGORY_MESSAGES.nameTaken },
};
const ITEM_CONSTRAINT_FIELDS = {
  expense_items_category_code_name_key: { field: "name", message: EXPENSE_CATEGORY_MESSAGES.itemNameTaken },
};

// ---------- The catalog ----------

/** fixed_channel_id is FK'd to channels (0048), so a DB value is always a ChannelId. */
function toCategoryInfo<T extends { fixedChannelId: string | null }>(row: T): Omit<T, "fixedChannelId"> & { fixedChannelId: ChannelId | null } {
  return { ...row, fixedChannelId: row.fixedChannelId as ChannelId | null };
}

const categoryColumns = {
  code: expenseCategories.code,
  name: sql<string>`${expenseCategories.name}::text`,
  kind: expenseCategories.kind,
  fixedChannelId: expenseCategories.fixedChannelId,
  isSystem: expenseCategories.isSystem,
  isActive: expenseCategories.isActive,
  sortOrder: expenseCategories.sortOrder,
};

/** Every category (inactive included) and every ACTIVE item, in display order. Two small reads
 * over reference tables; pages use the per-request cached loadExpenseCategoryCatalog. */
export async function getExpenseCategoryCatalog(db: Database = defaultDb): Promise<ExpenseCategoryCatalog> {
  const [categories, items] = await Promise.all([
    db
      .select(categoryColumns)
      .from(expenseCategories)
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.name), asc(expenseCategories.code)),
    db
      .select({
        id: expenseItems.id,
        categoryCode: expenseItems.categoryCode,
        name: sql<string>`${expenseItems.name}::text`,
        note: expenseItems.note,
        defaultAmount: expenseItems.defaultAmount,
        sortOrder: expenseItems.sortOrder,
      })
      .from(expenseItems)
      .where(eq(expenseItems.isActive, true))
      .orderBy(asc(expenseItems.categoryCode), asc(expenseItems.sortOrder), asc(expenseItems.name), asc(expenseItems.id)),
  ]);
  return { categories: categories.map(toCategoryInfo), items };
}

/** getExpenseCategoryCatalog once per request (React cache): a page and the components it renders
 * share one read. Admin pages are dynamic, so nothing outlives the request and no invalidation is
 * needed after a write. */
export const loadExpenseCategoryCatalog = cache(() => getExpenseCategoryCatalog());

// ---------- Category list and writes (Data Master, session S3) ----------

export interface ExpenseCategoryListRow extends ExpenseCategoryInfo {
  /** Items, active or not. */
  itemCount: number;
  /** Expenses recorded against it, voided included. */
  expenseCount: number;
}

/** The management list, in display order. Counts are correlated subqueries, so the two counts
 * never multiply each other the way a double LEFT JOIN would. */
export async function listExpenseCategories(db: Database = defaultDb): Promise<ExpenseCategoryListRow[]> {
  const rows = await db
    .select({
      ...categoryColumns,
      // qualifiedColumn on both sides: a bare interpolation renders unqualified without a join
      // (packages/db/src/sql-helpers.ts), which would not correlate to the outer row.
      itemCount: sql<number>`(select count(*) from ${expenseItems} where ${q(expenseItems, expenseItems.categoryCode)} = ${q(expenseCategories, expenseCategories.code)})::int`,
      expenseCount: sql<number>`(select count(*) from ${businessExpenses} where ${q(businessExpenses, businessExpenses.category)} = ${q(expenseCategories, expenseCategories.code)})::int`,
    })
    .from(expenseCategories)
    .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.name), asc(expenseCategories.code));
  return rows.map(toCategoryInfo);
}

export async function getExpenseCategory(code: string, db: Database = defaultDb): Promise<ExpenseCategoryInfo | null> {
  if (!CODE_PATTERN.test(code)) return null;
  const [row] = await db.select(categoryColumns).from(expenseCategories).where(eq(expenseCategories.code, code)).limit(1);
  return row ? toCategoryInfo(row) : null;
}

/** "Biaya  PRODUKSI" is the reserved name too, the same comparison as expense_categories_name_check. */
function isReservedCategoryName(name: string): boolean {
  return name.trim().replace(/\s+/g, " ").toLowerCase() === RESERVED_EXPENSE_CATEGORY_NAME.toLowerCase();
}

function normalizeCategoryName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name === "") throw new FieldError("name", EXPENSE_CATEGORY_MESSAGES.nameRequired);
  if (name.length > MAX_CATEGORY_NAME) throw new FieldError("name", EXPENSE_CATEGORY_MESSAGES.nameTooLong);
  if (isReservedCategoryName(name)) throw new FieldError("name", EXPENSE_CATEGORY_MESSAGES.nameReserved);
  return name;
}

function normalizeSortOrder(value: number): number {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 2_147_483_647) throw new FieldError("sortOrder", EXPENSE_CATEGORY_MESSAGES.sortOrder);
  return value;
}

/** "Langganan & Tools" -> "langganan_tools", "Ongkos Jahit Ekstra" -> "ongkos_jahit_ekstra". Always
 * matches CODE_PATTERN with room for a "_NN" suffix; never the reserved code. Exported for tests. */
export function expenseCategoryCodeBase(name: string): string {
  let base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = `k_${base}`.replace(/_+$/, "");
  base = base.slice(0, MAX_CODE_LENGTH - 4).replace(/_+$/, "");
  return base;
}

/** base, base_2, base_3, ...: every candidate is a valid code and never the reserved one. */
function codeCandidate(base: string, attempt: number): string {
  const code = attempt === 1 ? base : `${base}_${attempt}`;
  return code === RESERVED_EXPENSE_CATEGORY_CODE ? `${base}_x${attempt}` : code;
}

export interface CreateExpenseCategoryInput {
  name: string;
  kind: ExpenseCategoryKind;
  sortOrder: number;
}

const MAX_CODE_ATTEMPTS = 50;

/** The code is generated from the name (plan §3.5) and is immutable afterwards. A taken code is
 * not pre-checked: the INSERT ... ON CONFLICT (code) DO NOTHING returns no row and the next
 * suffix is tried, atomically. A taken NAME is the unique constraint's error, mapped. Owner-made
 * categories are never system and never carry a fixed channel (CHECKs). */
export async function createExpenseCategory(input: CreateExpenseCategoryInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  const name = normalizeCategoryName(input.name);
  if (!(EXPENSE_CATEGORY_KINDS as readonly string[]).includes(input.kind)) throw new FieldError("kind", EXPENSE_CATEGORY_MESSAGES.kind);
  const sortOrder = normalizeSortOrder(input.sortOrder);
  const base = expenseCategoryCodeBase(name);

  return db.transaction(async (tx) => {
    try {
      for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
        const [created] = await tx
          .insert(expenseCategories)
          .values({ code: codeCandidate(base, attempt), name, kind: input.kind, sortOrder, isSystem: false, isActive: true, fixedChannelId: null })
          .onConflictDoNothing({ target: expenseCategories.code })
          .returning();
        if (created) {
          await writeAuditLog(tx, { actorStaffUserId, action: "create", entityType: "expense_category", entityId: created.code, after: created });
          return created;
        }
      }
      throw new Error(`no free expense category code for "${base}"`);
    } catch (error) {
      mapUniqueViolation(error, CATEGORY_CONSTRAINT_FIELDS);
    }
  });
}

async function lockCategoryForUpdate(tx: Tx, code: string) {
  if (!CODE_PATTERN.test(code)) return null;
  // NO KEY UPDATE, not UPDATE: still conflicts with the record path's FOR SHARE, but not with the
  // FK check's KEY SHARE, so a rename never blocks an unrelated expense insert.
  const [row] = await tx.select().from(expenseCategories).where(eq(expenseCategories.code, code)).for("no key update");
  return row ?? null;
}

export interface UpdateExpenseCategoryInput {
  name: string;
  sortOrder: number;
}

/** Name and order only: code, kind and fixed channel never change (plan §3.1; the
 * prevent_expense_category_identity_change trigger is the backstop). */
export async function updateExpenseCategory(code: string, input: UpdateExpenseCategoryInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  const name = normalizeCategoryName(input.name);
  const sortOrder = normalizeSortOrder(input.sortOrder);
  return db.transaction(async (tx) => {
    const before = await lockCategoryForUpdate(tx, code);
    if (!before) throw new ActionError(EXPENSE_CATEGORY_MESSAGES.categoryNotFound);
    try {
      const [after] = await tx.update(expenseCategories).set({ name, sortOrder }).where(eq(expenseCategories.code, code)).returning();
      if (!after) throw new Error("failed to update expense category");
      await writeAuditLog(tx, { actorStaffUserId, action: "update", entityType: "expense_category", entityId: code, before, after });
      return after;
    } catch (error) {
      mapUniqueViolation(error, CATEGORY_CONSTRAINT_FIELDS);
    }
  });
}

/** No delete, ever (plan §3.6): "Nonaktifkan" hides it from new expenses and the monthly-bill
 * options; past expenses and reports keep it. A system category is refused here (friendly) and by
 * expense_categories_system_active_check (backstop). */
export async function setExpenseCategoryActive(code: string, isActive: boolean, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const before = await lockCategoryForUpdate(tx, code);
    if (!before) throw new ActionError(EXPENSE_CATEGORY_MESSAGES.categoryNotFound);
    if (!isActive && before.isSystem) throw new ActionError(EXPENSE_CATEGORY_MESSAGES.systemCannotDeactivate);
    const [after] = await tx.update(expenseCategories).set({ isActive }).where(eq(expenseCategories.code, code)).returning();
    if (!after) throw new Error("failed to update expense category");
    await writeAuditLog(tx, { actorStaffUserId, action: isActive ? "activate" : "deactivate", entityType: "expense_category", entityId: code, before, after });
    return after;
  });
}

// ---------- Items ----------

export interface ExpenseItemListRow extends ExpenseItemInfo {
  isActive: boolean;
  /** Expenses recorded against it, voided included. */
  expenseCount: number;
}

/** Every item of one category (inactive included), in display order. */
export async function listExpenseItems(categoryCode: string, db: Database = defaultDb): Promise<ExpenseItemListRow[]> {
  if (!CODE_PATTERN.test(categoryCode)) return [];
  return db
    .select({
      id: expenseItems.id,
      categoryCode: expenseItems.categoryCode,
      name: sql<string>`${expenseItems.name}::text`,
      note: expenseItems.note,
      defaultAmount: expenseItems.defaultAmount,
      sortOrder: expenseItems.sortOrder,
      isActive: expenseItems.isActive,
      // Both sides qualified: business_expenses has its own "id", so a bare one would self-compare.
      expenseCount: sql<number>`(select count(*) from ${businessExpenses} where ${q(businessExpenses, businessExpenses.itemId)} = ${q(expenseItems, expenseItems.id)})::int`,
    })
    .from(expenseItems)
    .where(eq(expenseItems.categoryCode, categoryCode))
    .orderBy(asc(expenseItems.sortOrder), asc(expenseItems.name), asc(expenseItems.id));
}

export interface ExpenseItemInput {
  name: string;
  note?: string | null;
  defaultAmount?: number | null;
  sortOrder: number;
}

function normalizeItemInput(input: ExpenseItemInput) {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name === "") throw new FieldError("name", EXPENSE_CATEGORY_MESSAGES.itemNameRequired);
  if (name.length > MAX_ITEM_NAME) throw new FieldError("name", EXPENSE_CATEGORY_MESSAGES.itemNameTooLong);
  const note = input.note?.trim() || null;
  if (note !== null && note.length > MAX_ITEM_NOTE) throw new FieldError("note", EXPENSE_CATEGORY_MESSAGES.itemNoteTooLong);
  const defaultAmount = input.defaultAmount ?? null;
  if (defaultAmount !== null && (!Number.isSafeInteger(defaultAmount) || defaultAmount <= 0 || defaultAmount > MAX_DEFAULT_AMOUNT)) {
    throw new FieldError("defaultAmount", EXPENSE_CATEGORY_MESSAGES.itemDefaultAmount);
  }
  return { name, note, defaultAmount, sortOrder: normalizeSortOrder(input.sortOrder) };
}

/** An item in an existing category (inactive categories too: the owner may prepare one before
 * reactivating it). A missing category is the FK's 23503, mapped. */
export async function createExpenseItem(categoryCode: string, input: ExpenseItemInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  const values = normalizeItemInput(input);
  if (!CODE_PATTERN.test(categoryCode)) throw new ActionError(EXPENSE_CATEGORY_MESSAGES.categoryNotFound);
  return db.transaction(async (tx) => {
    try {
      const [created] = await tx
        .insert(expenseItems)
        .values({ ...values, categoryCode, isActive: true })
        .returning();
      if (!created) throw new Error("failed to insert expense item");
      await writeAuditLog(tx, { actorStaffUserId, action: "create", entityType: "expense_item", entityId: created.id, after: created });
      return created;
    } catch (error) {
      if (isPostgresErrorCode(error, "23503")) throw new ActionError(EXPENSE_CATEGORY_MESSAGES.categoryNotFound);
      mapUniqueViolation(error, ITEM_CONSTRAINT_FIELDS);
    }
  });
}

async function lockItemForUpdate(tx: Tx, id: string) {
  if (!UUID_PATTERN.test(id)) return null;
  const [row] = await tx.select().from(expenseItems).where(eq(expenseItems.id, id)).for("no key update");
  return row ?? null;
}

/** Name, note, default amount and order. The category never changes
 * (prevent_expense_item_category_change). Not snapshotted on expenses, so a rename shows on past
 * ones too (plan §3.3, owner answer D6). */
export async function updateExpenseItem(id: string, input: ExpenseItemInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  const values = normalizeItemInput(input);
  return db.transaction(async (tx) => {
    const before = await lockItemForUpdate(tx, id);
    if (!before) throw new ActionError(EXPENSE_CATEGORY_MESSAGES.itemNotFound);
    try {
      const [after] = await tx.update(expenseItems).set(values).where(eq(expenseItems.id, id)).returning();
      if (!after) throw new Error("failed to update expense item");
      await writeAuditLog(tx, { actorStaffUserId, action: "update", entityType: "expense_item", entityId: id, before, after });
      return after;
    } catch (error) {
      mapUniqueViolation(error, ITEM_CONSTRAINT_FIELDS);
    }
  });
}

export async function setExpenseItemActive(id: string, isActive: boolean, actorStaffUserId: string | null, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const before = await lockItemForUpdate(tx, id);
    if (!before) throw new ActionError(EXPENSE_CATEGORY_MESSAGES.itemNotFound);
    const [after] = await tx.update(expenseItems).set({ isActive }).where(eq(expenseItems.id, id)).returning();
    if (!after) throw new Error("failed to update expense item");
    await writeAuditLog(tx, { actorStaffUserId, action: isActive ? "activate" : "deactivate", entityType: "expense_item", entityId: id, before, after });
    return after;
  });
}

// ---------- Selecting a category for a NEW expense ----------

export interface SelectedExpenseCategory {
  category: ExpenseCategoryInfo;
  item: { id: string; name: string } | null;
}

/** A plain read with the same rules as the lock below, for validating a form BEFORE its proof is
 * stored (so a refused form leaves no object behind). Not a guard: the write re-checks under
 * lockSelectableExpenseCategoryAndItem. */
export async function getSelectableExpenseCategory(code: string, db: Database = defaultDb): Promise<ExpenseCategoryInfo> {
  if (!CODE_PATTERN.test(code)) throw new FieldError("category", EXPENSE_CATEGORY_MESSAGES.categoryRequired);
  const [row] = await db.select(categoryColumns).from(expenseCategories).where(eq(expenseCategories.code, code)).limit(1);
  // An unknown code can only come from a stale or edited form: ask for a pick.
  if (!row) throw new FieldError("category", EXPENSE_CATEGORY_MESSAGES.categoryRequired);
  if (!row.isActive) throw new FieldError("category", EXPENSE_CATEGORY_MESSAGES.categoryInactive(row.name));
  return toCategoryInfo(row);
}

/** For a write that is about to record a NEW expense against `code` (and `itemId`): `SELECT ...
 * FOR SHARE` both and reject an unknown or inactive one (field-scoped, Indonesian). FOR SHARE, so a
 * concurrent setExpenseCategoryActive/setExpenseItemActive (an UPDATE) waits for this transaction
 * instead of slipping in between the check and the INSERT, the same shape as
 * lockSelectableProductType. Historical expenses never pass through here, so deactivating never
 * touches them. The item must belong to the category (also the composite FK). */
export async function lockSelectableExpenseCategoryAndItem(tx: Tx, code: string, itemId: string | null): Promise<SelectedExpenseCategory> {
  if (!CODE_PATTERN.test(code)) throw new FieldError("category", EXPENSE_CATEGORY_MESSAGES.categoryRequired);
  const [row] = await tx.select(categoryColumns).from(expenseCategories).where(eq(expenseCategories.code, code)).for("share");
  // An unknown code can only come from a stale or edited form: ask for a pick.
  if (!row) throw new FieldError("category", EXPENSE_CATEGORY_MESSAGES.categoryRequired);
  if (!row.isActive) throw new FieldError("category", EXPENSE_CATEGORY_MESSAGES.categoryInactive(row.name));
  if (itemId === null) return { category: toCategoryInfo(row), item: null };

  if (!UUID_PATTERN.test(itemId)) throw new FieldError("itemId", EXPENSE_CATEGORY_MESSAGES.itemNotFound);
  const [item] = await tx
    .select({ id: expenseItems.id, name: sql<string>`${expenseItems.name}::text`, isActive: expenseItems.isActive })
    .from(expenseItems)
    .where(and(eq(expenseItems.id, itemId), eq(expenseItems.categoryCode, code)))
    .for("share");
  if (!item) throw new FieldError("itemId", EXPENSE_CATEGORY_MESSAGES.itemNotFound);
  if (!item.isActive) throw new FieldError("itemId", EXPENSE_CATEGORY_MESSAGES.itemInactive(item.name));
  return { category: toCategoryInfo(row), item: { id: item.id, name: item.name } };
}
