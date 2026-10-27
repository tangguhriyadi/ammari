import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { checkIn, createdAtOnly } from "./columns";
import {
  BUSINESS_EXPENSE_CATEGORIES,
  BUSINESS_EXPENSE_METHODS,
  FIXED_EXPENSE_CHANNELS,
  MARKETING_EXPENSE_CATEGORIES,
  type BusinessExpenseCategory,
  type BusinessExpenseMethod,
  type ChannelId,
  type PrivateFilePurpose,
} from "./constants";
import { channels } from "./orders";
import { privateFiles } from "./supplier-payments";
import { staffUsers } from "./rbac";

// ---------- Iklan & Biaya — migration 0042 ----------
// docs/plans/growth.md §3. One row per ad or operating expense actually paid, with a REQUIRED
// proof in the private bucket. Append-only like supplier_payments: the hand-authored trigger in
// 0042 (prevent_voidable_record_mutation, shared with 0038) refuses DELETE and any UPDATE except
// the one-time void stamp. Not the never-used `expenses` table from migration 0000 (plan G1).

const fixedChannelCases = Object.entries(FIXED_EXPENSE_CHANNELS)
  .map(([category, channel]) => `when category = '${category}' then channel_id is not distinct from '${channel}'`)
  .join(" ");

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
    category: text("category").$type<BusinessExpenseCategory>().notNull(),
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
    foreignKey({
      columns: [table.proofFileId, table.proofFilePurpose],
      foreignColumns: [privateFiles.id, privateFiles.purpose],
      name: "business_expenses_proof_file_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("business_expenses_category_check", checkIn(table.category, BUSINESS_EXPENSE_CATEGORIES)),
    check("business_expenses_method_check", checkIn(table.method, BUSINESS_EXPENSE_METHODS)),
    check("business_expenses_amount_check", sql`${table.amount} > 0`),
    // Iklan Shopee/TikTok always name their own channel; Meta and Endorse/KOL may name one;
    // operating costs never do. CASE never yields NULL here (IS NOT DISTINCT FROM, IS NULL), so a
    // missing channel cannot slip through as "unknown".
    check(
      "business_expenses_channel_check",
      sql`case ${sql.raw(fixedChannelCases)} when ${checkIn(table.category, MARKETING_EXPENSE_CATEGORIES)} then true else ${table.channelId} is null end`,
    ),
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
