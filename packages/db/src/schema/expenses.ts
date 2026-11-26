import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { checkIn, citext, createdAtOnly, timestamps } from "./columns";
import {
  BUSINESS_EXPENSE_METHODS,
  EXPENSE_CATEGORY_KINDS,
  RESERVED_EXPENSE_CATEGORY_CODE,
  RESERVED_EXPENSE_CATEGORY_NAME,
  type BusinessExpenseCategory,
  type BusinessExpenseMethod,
  type ChannelId,
  type ExpenseCategoryKind,
  type PrivateFilePurpose,
} from "./constants";
import { channels } from "./orders";
import { privateFiles } from "./supplier-payments";
import { staffUsers } from "./rbac";

/** A constant as an SQL string literal inside DDL (same reasoning as checkIn's sql.raw: a bound
 * parameter would be dead text in a migration file). Quotes are doubled, so a future constant
 * containing one cannot break the statement. Only ever called with our own constants. */
function sqlLiteral(value: string) {
  return sql.raw(`'${value.replace(/'/g, "''")}'`);
}

// ---------- Kategori Biaya — migration 0048 ----------
// docs/plans/expense-master-data.md §3.1. The owner's categories and, per category, the cost items
// ("Item biaya") an expense is recorded against. Neither is ever deleted (hand-authored triggers in
// 0048); "delete" in the admin is is_active = false. Hand-authored in 0048 as well:
//   - prevent_expense_category_identity_change: code, kind, fixed_channel_id and is_system never
//     change (a kind change would silently move historical spend in or out of ROAS);
//   - prevent_expense_item_category_change: an item stays in its category;
//   - set_updated_at on both tables.

export const expenseCategories = pgTable(
  "expense_categories",
  {
    // Lowercase snake, the value business_expenses.category stores. The ten pre-0048 codes are
    // kept as they were (DEFAULT_EXPENSE_CATEGORIES); new ones are generated from the name.
    code: text("code").primaryKey(),
    // Indonesian display name. citext UNIQUE so "Gaji" and "gaji" can't be two categories.
    name: citext("name").notNull().unique(),
    kind: text("kind").$type<ExpenseCategoryKind>().notNull(),
    // Only the system Iklan Shopee/TikTok: every expense in the category names this channel.
    fixedChannelId: text("fixed_channel_id")
      .$type<ChannelId>()
      .references(() => channels.id, { onDelete: "restrict", onUpdate: "restrict" }),
    // The app's logic matches this code by literal (ROAS, fixed channel, "Lainnya" note rule).
    isSystem: boolean("is_system").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    // Same convention as product_types.sort_order: lists order by (sort_order, name).
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    index("expense_categories_fixed_channel_id_idx").on(table.fixedChannelId),
    check("expense_categories_code_check", sql`${table.code} ~ '^[a-z][a-z0-9_]{0,39}$' and ${table.code} <> ${sqlLiteral(RESERVED_EXPENSE_CATEGORY_CODE)}`),
    // The reserved name is compared case- and whitespace-insensitively ("Biaya  PRODUKSI" too).
    check(
      "expense_categories_name_check",
      sql`btrim(${table.name}::text) <> '' and char_length(${table.name}::text) <= 60 and regexp_replace(lower(btrim(${table.name}::text)), '\\s+', ' ', 'g') <> ${sqlLiteral(RESERVED_EXPENSE_CATEGORY_NAME.toLowerCase())}`,
    ),
    check("expense_categories_kind_check", checkIn(table.kind, EXPENSE_CATEGORY_KINDS)),
    // A fixed channel is an ad rule, and only the shipped system categories carry one.
    check("expense_categories_fixed_channel_check", sql`${table.fixedChannelId} is null or (${table.kind} = 'ad' and ${table.isSystem})`),
    // System categories are never deactivated.
    check("expense_categories_system_active_check", sql`${table.isActive} or not ${table.isSystem}`),
  ],
);

export const expenseItems = pgTable(
  "expense_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryCode: text("category_code")
      .notNull()
      .references(() => expenseCategories.code, { onDelete: "restrict", onUpdate: "restrict" }),
    // "Biteship Grow", "VPS". Unique within its category, case-insensitively.
    name: citext("name").notNull(),
    note: text("note"),
    // Prefills "Jumlah" on the record form (owner answer D4). Whole rupiah.
    defaultAmount: bigint("default_amount", { mode: "number" }),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    unique("expense_items_category_code_name_key").on(table.categoryCode, table.name),
    // Target of business_expenses_item_category_fk: an expense's item is in the expense's category.
    unique("expense_items_id_category_code_key").on(table.id, table.categoryCode),
    check("expense_items_name_check", sql`btrim(${table.name}::text) <> '' and char_length(${table.name}::text) <= 80`),
    check("expense_items_note_check", sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= 200)`),
    // Same ceiling as MAX_EXPENSE_AMOUNT in apps/admin lib/expenses/records.ts.
    check("expense_items_default_amount_check", sql`${table.defaultAmount} is null or (${table.defaultAmount} > 0 and ${table.defaultAmount} <= 1000000000)`),
  ],
);

// ---------- Iklan & Biaya — migration 0042 ----------
// docs/plans/growth.md §3. One row per ad or operating expense actually paid, with a REQUIRED
// proof in the private bucket. Append-only like supplier_payments: the hand-authored trigger in
// 0042 (prevent_voidable_record_mutation, shared with 0038) refuses DELETE and any UPDATE except
// the one-time void stamp. Not the never-used `expenses` table from migration 0000 (plan G1).

export const businessExpenses = pgTable(
  "business_expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // BYA-YYYYMM-NNN, generated under a per-month advisory lock (lib/documents/document-number.ts);
    // the unique constraint is the backstop.
    expenseNo: text("expense_no").notNull().unique(),
    // The Asia/Jakarta calendar day the money left. Never in the future (app-checked). Laba bersih
    // counts an expense on this date (cash basis, owner answer Q3).
    expenseDate: date("expense_date", { mode: "string" }).notNull(),
    // An expense_categories code (FK since 0048, replacing the CHECK over the fixed list).
    category: text("category")
      .$type<BusinessExpenseCategory>()
      .notNull()
      .references(() => expenseCategories.code, { onDelete: "restrict", onUpdate: "restrict" }),
    // Migration 0048: the cost item picked on the form. NULL on every expense recorded before
    // items existed (append-only rows are never backfilled) and on categories without items.
    // business_expenses_item_category_fk keeps it inside the expense's own category.
    itemId: uuid("item_id"),
    amount: bigint("amount", { mode: "number" }).notNull(),
    method: text("method").$type<BusinessExpenseMethod>().notNull(),
    // The sales channel an ad or endorse is for: fixed for Iklan Shopee/TikTok, optional for Meta
    // and Endorse/KOL (owner answer Q14), never set for an operating cost.
    channelId: text("channel_id")
      .$type<ChannelId>()
      .references(() => channels.id, { onDelete: "restrict" }),
    campaign: text("campaign"),
    note: text("note"),
    // Required. Unique: one proof file belongs to exactly one expense.
    proofFileId: uuid("proof_file_id").notNull().unique(),
    // Constant; the composite FK below guarantees the file was stored as an expense proof (same
    // technique as supplier_payments.proof_file_purpose).
    proofFilePurpose: text("proof_file_purpose").$type<PrivateFilePurpose>().notNull().default("expense_proof"),
    recordedByStaffUserId: uuid("recorded_by_staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "restrict" }),
    voidedAt: timestamp("voided_at", { withTimezone: true, mode: "date" }),
    voidedByStaffUserId: uuid("voided_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    voidReason: text("void_reason"),
    // = recorded_at.
    ...createdAtOnly(),
  },
  (table) => [
    // Ascending on purpose: the list's ORDER BY expense_date DESC, created_at DESC (NULLS FIRST by
    // default) is served by a backward scan; a `.desc()` index is NULLS LAST and would not match.
    index("business_expenses_expense_date_created_at_idx").on(table.expenseDate, table.createdAt),
    index("business_expenses_category_expense_date_idx").on(table.category, table.expenseDate),
    index("business_expenses_channel_id_idx").on(table.channelId),
    index("business_expenses_recorded_by_staff_user_id_idx").on(table.recordedByStaffUserId),
    index("business_expenses_voided_by_staff_user_id_idx").on(table.voidedByStaffUserId),
    index("business_expenses_item_id_idx").on(table.itemId),
    // MATCH SIMPLE: a NULL item_id skips the check.
    foreignKey({
      columns: [table.itemId, table.category],
      foreignColumns: [expenseItems.id, expenseItems.categoryCode],
      name: "business_expenses_item_category_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      columns: [table.proofFileId, table.proofFilePurpose],
      foreignColumns: [privateFiles.id, privateFiles.purpose],
      name: "business_expenses_proof_file_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("business_expenses_method_check", checkIn(table.method, BUSINESS_EXPENSE_METHODS)),
    check("business_expenses_amount_check", sql`${table.amount} > 0`),
    // The channel rule (a fixed channel names exactly it, ad/endorsement may name one, operating
    // never does) is the business_expense_channel_rule trigger since 0048: it reads the
    // category's kind and fixed_channel_id, which a CHECK cannot.
    check("business_expenses_campaign_check", sql`${table.campaign} is null or (btrim(${table.campaign}) <> '' and char_length(${table.campaign}) <= 120)`),
    check("business_expenses_note_check", sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= 500)`),
    // "Lainnya" says what it was (owner answer Q1).
    check("business_expenses_other_note_check", sql`${table.category} <> 'other' or ${table.note} is not null`),
    check("business_expenses_proof_file_purpose_check", sql`${table.proofFilePurpose} = 'expense_proof'`),
    check(
      "business_expenses_voided_triple_check",
      sql`num_nonnulls(${table.voidedAt}, ${table.voidedByStaffUserId}, ${table.voidReason}) in (0, 3) and (${table.voidReason} is null or btrim(${table.voidReason}) <> '')`,
    ),
  ],
);
