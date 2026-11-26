import "server-only";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { alias, unionAll } from "drizzle-orm/pg-core";
import {
  businessExpenses,
  expenseCategories,
  expenseItems,
  privateFiles,
  staffUsers,
  supplierPayments,
  type BusinessExpenseCategory,
  type BusinessExpenseMethod,
  type ChannelId,
} from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { nextDocumentNumber } from "@/lib/documents/document-number";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { privateFileValues, type PrivateFileRef } from "@/lib/supplier-payments/payment-records";
import type { StoredPrivateFile } from "@/lib/supplier-payments/store-upload";
import type { ExpenseCategoryRule } from "@/lib/expense-categories/catalog";
import { lockSelectableExpenseCategoryAndItem } from "@/lib/expense-categories/queries";
import { expenseChannelError, expenseChannelRule, monthRange, type DateRange } from "./figures";
import { EXPENSE_CATEGORY_GROUPS, type ExpenseCategoryGroup } from "./labels";

// "Iklan & Biaya" write paths and list read (docs/plans/growth.md §5, session S2). Same shape as
// supplier payments (lib/supplier-payments/payment-records.ts): the proof is processed and stored
// BEFORE the transaction (store-upload.ts), and the private_files row, the expense row and the
// audit entry are written in ONE transaction. There is no balance cap here, so no parent row to
// lock: the unique expense_no (under nextDocumentNumber's advisory lock) and the unique
// proof_file_id are the concurrency guards, and voiding is a conditional UPDATE.

export const MAX_EXPENSE_AMOUNT = 1_000_000_000;
export const MAX_CAMPAIGN_LENGTH = 120;
export const MAX_EXPENSE_NOTE_LENGTH = 500;
export const MAX_VOID_REASON_LENGTH = 500;
/** No real expense is older; also keeps a typo like 0026-10-05 (which Postgres would refuse
 * inside the transaction, after the proof was stored) a friendly field error instead. */
export const MIN_EXPENSE_DATE = "2000-01-01";

export const EXPENSE_MESSAGES = {
  invalidDate: "Tanggal bayar tidak valid.",
  futureDate: "Tanggal bayar tidak boleh di masa depan.",
  amount: "Jumlah harus bilangan bulat lebih dari 0, maksimal Rp1.000.000.000.",
  campaignNotMarketing: "Kampanye hanya untuk biaya iklan atau endorse.",
  campaignTooLong: `Kampanye maksimal ${MAX_CAMPAIGN_LENGTH} karakter.`,
  noteTooLong: `Catatan maksimal ${MAX_EXPENSE_NOTE_LENGTH} karakter.`,
  noteRequired: "Untuk kategori Lainnya, tulis di catatan biaya apa ini.",
  reasonRequired: "Alasan pembatalan wajib diisi.",
  reasonTooLong: `Alasan maksimal ${MAX_VOID_REASON_LENGTH} karakter.`,
  notFound: "Biaya tidak ditemukan.",
  alreadyVoided: "Biaya ini sudah dibatalkan.",
} as const;

export interface BusinessExpenseInput {
  expenseDate: string;
  category: BusinessExpenseCategory;
  /** An expense_items id of `category` (owner answer D1: picked from the list, never typed).
   * Required when the category has active items; checked against the table, not here. */
  itemId?: string | null;
  amount: number;
  method: BusinessExpenseMethod;
  channelId: ChannelId | null;
  campaign?: string | null;
  note?: string | null;
}

export type NormalizedExpenseInput = Required<BusinessExpenseInput>;

function optionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** Every input rule, mirroring the CHECKs of business_expenses and the channel trigger (plus the
 * stricter channel list), as a FieldError naming the form field. `category` is the chosen
 * category's row (kind and fixed channel decide the channel and campaign rules). Runs before the
 * file is stored, so a refused form never leaves an object behind, and again inside the write
 * transaction against the locked row. */
export function normalizeExpenseInput(input: BusinessExpenseInput, category: ExpenseCategoryRule): NormalizedExpenseInput {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expenseDate) || new Date(`${input.expenseDate}T00:00:00Z`).toISOString().slice(0, 10) !== input.expenseDate) {
    throw new FieldError("expenseDate", EXPENSE_MESSAGES.invalidDate);
  }
  if (input.expenseDate < MIN_EXPENSE_DATE) throw new FieldError("expenseDate", EXPENSE_MESSAGES.invalidDate);
  // "Not in the future" (Asia/Jakarta); the floor above only catches typos.
  if (input.expenseDate > todayInJakarta()) throw new FieldError("expenseDate", EXPENSE_MESSAGES.futureDate);
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > MAX_EXPENSE_AMOUNT) {
    throw new FieldError("amount", EXPENSE_MESSAGES.amount);
  }

  const rule = expenseChannelRule(category);
  const channelId = rule.kind === "fixed" && input.channelId === null ? rule.channelId : input.channelId;
  const channelError = expenseChannelError(category, channelId);
  if (channelError) throw new FieldError("channelId", channelError);

  const campaign = optionalText(input.campaign);
  if (campaign !== null && rule.kind === "none") throw new FieldError("campaign", EXPENSE_MESSAGES.campaignNotMarketing);
  if (campaign !== null && campaign.length > MAX_CAMPAIGN_LENGTH) throw new FieldError("campaign", EXPENSE_MESSAGES.campaignTooLong);
  const note = optionalText(input.note);
  if (note !== null && note.length > MAX_EXPENSE_NOTE_LENGTH) throw new FieldError("note", EXPENSE_MESSAGES.noteTooLong);
  if (input.category === "other" && note === null) throw new FieldError("note", EXPENSE_MESSAGES.noteRequired);

  const itemId = optionalText(input.itemId);
  return { expenseDate: input.expenseDate, category: input.category, itemId, amount: input.amount, method: input.method, channelId, campaign, note };
}

export function normalizeVoidReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === "") throw new FieldError("reason", EXPENSE_MESSAGES.reasonRequired);
  if (trimmed.length > MAX_VOID_REASON_LENGTH) throw new FieldError("reason", EXPENSE_MESSAGES.reasonTooLong);
  return trimmed;
}

// ---------- Writes ----------

/** Plan §5 step 3: number (advisory lock), private_files row, expense row, audit `record`, in one
 * transaction. The file must already be in private storage (storePrivateUpload). The category and
 * the item are locked FOR SHARE and must be active, the item must belong to the category, and a
 * category with active items needs one (expense-master-data.md §3.5, S4): an inactive one is
 * refused for a NEW expense, while its past expenses stay as they are. The audit entry names the
 * item (id and its name at record time), since the list shows the item's CURRENT name (D6). */
export async function recordBusinessExpense(input: BusinessExpenseInput, file: StoredPrivateFile, actorStaffUserId: string, db: Database = defaultDb) {
  if (file.purpose !== "expense_proof") throw new Error(`expected an expense_proof file, got ${file.purpose}`);

  return db.transaction(async (tx) => {
    const { category, item } = await lockSelectableExpenseCategoryAndItem(tx, input.category, optionalText(input.itemId));
    const values = normalizeExpenseInput(input, category);
    const expenseNo = await nextDocumentNumber(tx, "BYA", businessExpenses.expenseNo);
    const [fileRow] = await tx.insert(privateFiles).values(privateFileValues(file, actorStaffUserId)).returning();
    if (!fileRow) throw new Error("failed to insert private file");
    const [row] = await tx
      .insert(businessExpenses)
      .values({ ...values, expenseNo, proofFileId: fileRow.id, recordedByStaffUserId: actorStaffUserId })
      .returning();
    if (!row) throw new Error("failed to insert business expense");

    await writeAuditLog(tx, { actorStaffUserId, action: "record", entityType: "business_expense", entityId: row.id, after: { expense: row, file: fileRow, item } });
    return row;
  });
}

/** Void once (plan G3): a conditional UPDATE; zero rows back means it was voided already (or
 * concurrently). The trigger refuses every other change. */
export async function voidBusinessExpense(expenseId: string, reason: string, actorStaffUserId: string, db: Database = defaultDb) {
  const trimmed = normalizeVoidReason(reason);

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(businessExpenses).where(eq(businessExpenses.id, expenseId));
    if (!before) throw new ActionError(EXPENSE_MESSAGES.notFound);
    const [row] = await tx
      .update(businessExpenses)
      .set({ voidedAt: new Date(), voidedByStaffUserId: actorStaffUserId, voidReason: trimmed })
      .where(and(eq(businessExpenses.id, expenseId), isNull(businessExpenses.voidedAt)))
      .returning();
    if (!row) throw new ActionError(EXPENSE_MESSAGES.alreadyVoided);

    await writeAuditLog(tx, { actorStaffUserId, action: "void", entityType: "business_expense", entityId: expenseId, before, after: row });
    return row;
  });
}

// ---------- Reads ----------

/** The soft duplicate-proof warning (plan §5 step 4): document numbers whose non-voided record
 * was uploaded with exactly these bytes. Supplier payments only for a viewer who may see them
 * (supplier_payments.manage). Advisory; never blocks. */
export async function findProofHashUses(
  originalSha256: string,
  { includeSupplierPayments }: { includeSupplierPayments: boolean },
  db: Database = defaultDb,
): Promise<string[]> {
  if (!/^[0-9a-f]{64}$/.test(originalSha256)) return [];
  const expenses = db
    .select({ no: businessExpenses.expenseNo })
    .from(businessExpenses)
    .innerJoin(privateFiles, eq(privateFiles.id, businessExpenses.proofFileId))
    .where(and(eq(privateFiles.originalSha256, originalSha256), isNull(businessExpenses.voidedAt)));
  const payments = db
    .select({ no: supplierPayments.paymentNo })
    .from(supplierPayments)
    .innerJoin(privateFiles, eq(privateFiles.id, supplierPayments.proofFileId))
    .where(and(eq(privateFiles.originalSha256, originalSha256), isNull(supplierPayments.voidedAt)));
  const rows = await (includeSupplierPayments ? unionAll(expenses, payments) : expenses).orderBy(asc(sql`1`)).limit(5);
  return rows.map((row) => row.no);
}

export interface BusinessExpenseFilters {
  /** "YYYY-MM", always set: the list is per month (owner answer Q3)... */
  month: string;
  /** ...unless a date window is given (inclusive Jakarta dates), which replaces it. */
  range?: DateRange;
  group?: ExpenseCategoryGroup;
  category?: BusinessExpenseCategory;
  showVoided?: boolean;
  q?: string;
}

export interface BusinessExpenseRow {
  id: string;
  expenseNo: string;
  expenseDate: string;
  category: BusinessExpenseCategory;
  amount: number;
  method: BusinessExpenseMethod;
  channelId: ChannelId | null;
  campaign: string | null;
  note: string | null;
  /** The item's CURRENT name (renames apply to past expenses, D6); null for an expense recorded
   * without one, as every expense before session S4. */
  itemName: string | null;
  recordedByName: string | null;
  createdAt: Date;
  proof: PrivateFileRef;
  voidedAt: Date | null;
  voidedByName: string | null;
  voidReason: string | null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** One month of expenses, newest payment date first, paginated, plus the total of the
 * non-voided rows matching the same filter (voided rows never count, P6). */
export async function listBusinessExpenses(
  filters: BusinessExpenseFilters,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: BusinessExpenseRow[]; pagination: Pagination; total: number }> {
  const range = filters.range ?? monthRange(filters.month);
  // The group is a set of kinds (labels.ts), so an owner-made category lands in its tab.
  const groupKinds = filters.group ? EXPENSE_CATEGORY_GROUPS.find((group) => group.key === filters.group)?.kinds : undefined;
  const q = filters.q?.trim();
  const pattern = q ? `%${escapeLike(q)}%` : null;
  const base: (SQL | undefined)[] = [
    gte(businessExpenses.expenseDate, range.from),
    lte(businessExpenses.expenseDate, range.to),
    groupKinds
      ? inArray(businessExpenses.category, db.select({ code: expenseCategories.code }).from(expenseCategories).where(inArray(expenseCategories.kind, [...groupKinds])))
      : undefined,
    filters.category ? eq(businessExpenses.category, filters.category) : undefined,
    pattern
      ? or(
          ilike(businessExpenses.expenseNo, pattern),
          ilike(businessExpenses.campaign, pattern),
          ilike(businessExpenses.note, pattern),
          // The item name too (plan S4); a subquery so the count and total need no join.
          inArray(businessExpenses.itemId, db.select({ id: expenseItems.id }).from(expenseItems).where(ilike(expenseItems.name, pattern))),
        )
      : undefined,
  ];
  const listWhere = and(...base, filters.showVoided ? undefined : isNull(businessExpenses.voidedAt));
  const totalWhere = and(...base, isNull(businessExpenses.voidedAt));

  const [[countRow], [totalRow]] = await Promise.all([
    db.select({ totalCount: count() }).from(businessExpenses).where(listWhere),
    db.select({ total: sql<string>`coalesce(sum(${businessExpenses.amount}), 0)::text` }).from(businessExpenses).where(totalWhere),
  ]);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: countRow?.totalCount ?? 0 });

  const recordedBy = alias(staffUsers, "recorded_by");
  const voidedBy = alias(staffUsers, "voided_by");
  const rows = await db
    .select({
      id: businessExpenses.id,
      expenseNo: businessExpenses.expenseNo,
      expenseDate: businessExpenses.expenseDate,
      category: businessExpenses.category,
      amount: businessExpenses.amount,
      method: businessExpenses.method,
      channelId: businessExpenses.channelId,
      campaign: businessExpenses.campaign,
      note: businessExpenses.note,
      itemName: sql<string | null>`${expenseItems.name}::text`,
      recordedByName: recordedBy.name,
      createdAt: businessExpenses.createdAt,
      fileId: privateFiles.id,
      fileContentType: privateFiles.contentType,
      fileName: privateFiles.originalFilename,
      voidedAt: businessExpenses.voidedAt,
      voidedByName: voidedBy.name,
      voidReason: businessExpenses.voidReason,
    })
    .from(businessExpenses)
    .innerJoin(privateFiles, eq(privateFiles.id, businessExpenses.proofFileId))
    .leftJoin(expenseItems, eq(expenseItems.id, businessExpenses.itemId))
    .leftJoin(recordedBy, eq(recordedBy.id, businessExpenses.recordedByStaffUserId))
    .leftJoin(voidedBy, eq(voidedBy.id, businessExpenses.voidedByStaffUserId))
    .where(listWhere)
    // Backed by business_expenses_expense_date_created_at_idx (backward scan); expense_no breaks ties.
    .orderBy(desc(businessExpenses.expenseDate), desc(businessExpenses.createdAt), desc(businessExpenses.expenseNo))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return {
    rows: rows.map(({ fileId, fileContentType, fileName, ...row }) => ({
      ...row,
      proof: { id: fileId, contentType: fileContentType, originalFilename: fileName },
    })),
    pagination,
    total: Number(totalRow?.total ?? 0),
  };
}
