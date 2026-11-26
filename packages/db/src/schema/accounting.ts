import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { suppliers } from "./catalog";
import { checkIn, citext, createdAtOnly, timestamps } from "./columns";
import {
  ACCOUNT_CODE_CLASS_TYPES,
  ACCOUNT_NORMAL_BALANCES,
  ACCOUNT_TYPES,
  CASH_BANK_ACCOUNT_CODE_PATTERN,
  ACCOUNTING_CUTOVER_DATE,
  ACCOUNTING_TRIAL_MONTH,
  CASH_FLOW_GROUPS,
  FISCAL_PERIOD_STATUSES,
  JOURNAL_ENTRY_KINDS,
  MANUAL_ORDER_PAYMENT_METHODS,
  POSTING_RUN_STATUSES,
  POSTING_RUN_TRIGGERS,
  TAXPAYER_TYPES,
  type AccountNormalBalance,
  type AccountType,
  type CashFlowGroup,
  type ChannelId,
  type FiscalPeriodStatus,
  type JournalEntryKind,
  type ManualOrderPaymentMethod,
  type PrivateFilePurpose,
  type PostingRunStatus,
  type PostingRunTrigger,
  type TaxpayerType,
} from "./constants";
import { channels, orders } from "./orders";
import { staffUsers } from "./rbac";
import { privateFiles } from "./supplier-payments";

// ---------- Akuntansi: buku besar berpasangan, migration 0049 ----------
// docs/plans/accounting.md §2.1, Session 1. A derived ledger: a posting service (packages/
// accounting) reads existing source records and writes journals into these tables only; no
// existing write path calls it. Hand-authored in 0049 (drizzle-kit emits no triggers):
//   - accounts: code, type, normal_balance, is_system and system_key are immutable; is_header
//     cannot be switched on once lines use the account; a system account or one any line uses is
//     never deleted;
//   - account_mappings: the target must be an active, postable (non-header) account;
//   - journal_entries / journal_lines: append-only (the one exception: the one-time
//     reversed_by_entry_id stamp, pointing at the entry's own reversal); a line goes only to an
//     active, postable account, in the transaction that created its entry; every entry balances
//     with at least two lines (deferred constraint triggers, checked at commit); nothing is
//     inserted into a closed month (shared/exclusive advisory lock per month, so a concurrent
//     close and post serialise); purchase-side journals never touch an expense-like account
//     (PURCHASE_SIDE_JOURNAL_SOURCES, D-14);
//   - fiscal_periods: closing takes the month's exclusive lock;
//   - set_updated_at on accounts, account_mappings, fiscal_periods, tax_settings.

/** Postgres CHECK regex for an account code: "1-1501". */
const ACCOUNT_CODE_PATTERN = "^[1-9]-[0-9]{4}$";

/** accounts_code_type_check (0051): the code's leading digit fixes the type (ACCOUNT_CODE_CLASS_TYPES). */
const ACCOUNT_CODE_TYPE_SQL = Object.entries(ACCOUNT_CODE_CLASS_TYPES)
  .map(([digit, types]) => `(left(code, 1) = '${digit}' and type in (${types.map((type) => `'${type}'`).join(", ")}))`)
  .join(" or ");

export const accounts = pgTable(
  "accounts",
  {
    code: text("code").primaryKey(),
    // Indonesian display name. citext UNIQUE so two accounts can't differ only by case.
    name: citext("name").notNull().unique(),
    type: text("type").$type<AccountType>().notNull(),
    normalBalance: text("normal_balance").$type<AccountNormalBalance>().notNull(),
    parentCode: text("parent_code").references((): AnyPgColumn => accounts.code, { onDelete: "restrict", onUpdate: "restrict" }),
    // A grouping row (1-1000 Aset lancar): never receives a journal line.
    isHeader: boolean("is_header").notNull().default(false),
    // Locked in plan §3: referenced by a posting rule through system_key.
    isSystem: boolean("is_system").notNull().default(false),
    systemKey: text("system_key").unique(),
    isActive: boolean("is_active").notNull().default(true),
    cashFlowGroup: text("cash_flow_group").$type<CashFlowGroup>().notNull().default("none"),
    // Cash/bank accounts only (D-17): shown in the Kas & Bank list.
    bankName: text("bank_name"),
    accountNoLast4: text("account_no_last4"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    index("accounts_parent_code_idx").on(table.parentCode),
    check("accounts_code_check", sql`${table.code} ~ ${sql.raw(`'${ACCOUNT_CODE_PATTERN}'`)}`),
    check("accounts_name_check", sql`btrim(${table.name}::text) <> '' and char_length(${table.name}::text) <= 80`),
    check("accounts_type_check", checkIn(table.type, ACCOUNT_TYPES)),
    check("accounts_normal_balance_check", checkIn(table.normalBalance, ACCOUNT_NORMAL_BALANCES)),
    check("accounts_cash_flow_group_check", checkIn(table.cashFlowGroup, CASH_FLOW_GROUPS)),
    check("accounts_parent_not_self_check", sql`${table.parentCode} is null or ${table.parentCode} <> ${table.code}`),
    // A system account is a posting target: postable, active, and carries its key.
    check("accounts_system_key_check", sql`(${table.systemKey} is not null) = ${table.isSystem}`),
    check("accounts_system_key_format_check", sql`${table.systemKey} is null or ${table.systemKey} ~ '^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$'`),
    check("accounts_system_postable_check", sql`not (${table.isSystem} and ${table.isHeader})`),
    check("accounts_system_active_check", sql`${table.isActive} or not ${table.isSystem}`),
    check("accounts_bank_name_check", sql`${table.bankName} is null or (btrim(${table.bankName}) <> '' and char_length(${table.bankName}) <= 60)`),
    check("accounts_account_no_last4_check", sql`${table.accountNoLast4} is null or ${table.accountNoLast4} ~ '^[0-9]{4}$'`),
    // Session 3 (plan §8.1): the leading digit is the class (1 asset ... 9 tax), and only a postable
    // Kas & Bank account (1-11xx, 1-12xx, D-17) carries bank fields.
    check("accounts_code_type_check", sql.raw(ACCOUNT_CODE_TYPE_SQL)),
    check(
      "accounts_bank_fields_cash_bank_check",
      sql`(${table.bankName} is null and ${table.accountNoLast4} is null)
        or (${table.code} ~ ${sql.raw(`'${CASH_BANK_ACCOUNT_CODE_PATTERN}'`)} and not ${table.isHeader})`,
    ),
  ],
);

export const accountMappings = pgTable(
  "account_mappings",
  {
    // "cash.method.transfer", "revenue.channel.shopee", "expense.category.salary",
    // "expense.item.<uuid>". A missing key is a posting issue, never a guess.
    mappingKey: text("mapping_key").primaryKey(),
    accountCode: text("account_code")
      .notNull()
      .references(() => accounts.code, { onDelete: "restrict", onUpdate: "restrict" }),
    ...timestamps(),
  },
  (table) => [
    index("account_mappings_account_code_idx").on(table.accountCode),
    check("account_mappings_key_check", sql`${table.mappingKey} ~ '^[a-z][a-z0-9_]*(\\.[a-z0-9_-]+)+$' and char_length(${table.mappingKey}) <= 120`),
  ],
);

export const fiscalPeriods = pgTable(
  "fiscal_periods",
  {
    // First day of the Asia/Jakarta calendar month. No row = open.
    month: date("month", { mode: "string" }).primaryKey(),
    status: text("status").$type<FiscalPeriodStatus>().notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    closedByStaffUserId: uuid("closed_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    // The last reopen (each one is also in audit_log). Reason is required (D-23).
    reopenedAt: timestamp("reopened_at", { withTimezone: true, mode: "date" }),
    reopenedByStaffUserId: uuid("reopened_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    reopenedReason: text("reopened_reason"),
    // Migration 0052 (Session 4, plan §7): the written reason when the month was closed while it
    // still had open posting issues ("explicit, reasoned override"). Only on a closed month; a
    // reopen clears it, the next close sets it again if needed. Each close is also in audit_log.
    closeOverrideReason: text("close_override_reason"),
    ...timestamps(),
  },
  (table) => [
    index("fiscal_periods_closed_by_staff_user_id_idx").on(table.closedByStaffUserId),
    index("fiscal_periods_reopened_by_staff_user_id_idx").on(table.reopenedByStaffUserId),
    check("fiscal_periods_month_check", sql`extract(day from ${table.month}) = 1`),
    check("fiscal_periods_status_check", checkIn(table.status, FISCAL_PERIOD_STATUSES)),
    check(
      "fiscal_periods_closed_stamp_check",
      sql`${table.status} <> 'closed' or (${table.closedAt} is not null and ${table.closedByStaffUserId} is not null)`,
    ),
    check(
      "fiscal_periods_reopen_stamp_check",
      sql`(${table.reopenedAt} is null and ${table.reopenedByStaffUserId} is null and ${table.reopenedReason} is null)
        or (${table.reopenedAt} is not null and ${table.reopenedByStaffUserId} is not null
            and ${table.reopenedReason} is not null and btrim(${table.reopenedReason}) <> '' and char_length(${table.reopenedReason}) <= 500)`,
    ),
    check(
      "fiscal_periods_close_override_reason_check",
      sql`${table.closeOverrideReason} is null
        or (${table.status} = 'closed' and btrim(${table.closeOverrideReason}) <> '' and char_length(${table.closeOverrideReason}) <= 500)`,
    ),
    // D-22: the trial month is posted but never locked.
    check("fiscal_periods_trial_month_open_check", sql`not (${table.month} = ${sql.raw(`'${ACCOUNTING_TRIAL_MONTH}'`)} and ${table.status} = 'closed')`),
  ],
);

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // JU-YYYYMM-NNNN, generated under a per-month advisory lock (same idiom as document numbers).
    entryNo: text("entry_no").notNull().unique(),
    // The date the entry counts on (Jakarta day). Moved to the first open month when the source's
    // own month is closed; source_date then keeps the original.
    entryDate: date("entry_date", { mode: "string" }).notNull(),
    sourceDate: date("source_date", { mode: "string" }),
    // The posting key (source_type, source_id, source_event): ('order', '<uuid>', 'recognised'),
    // ('tax', 'pph_final', '2027-01'). All three or none.
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    sourceEvent: text("source_event"),
    ruleVersion: integer("rule_version"),
    kind: text("kind").$type<JournalEntryKind>().notNull(),
    reversesEntryId: uuid("reverses_entry_id").unique(),
    // Stamped once, when this entry's reversal is inserted (the only UPDATE journals ever get).
    reversedByEntryId: uuid("reversed_by_entry_id").unique(),
    description: text("description").notNull(),
    // NULL for the posting runner; the staff member for manual/opening entries.
    postedByStaffUserId: uuid("posted_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    // sha256 of the normalised lines, so the runner can tell "unchanged" from "changed".
    contentHash: text("content_hash"),
    // Migration 0052 (Session 4, plan §5): the optional attachment of a manual or opening journal
    // (bank statement, dashboard screenshot), a private_files row of purpose journal_attachment
    // pinned by the composite FK. Written with the entry, never changed (append-only).
    attachmentFileId: uuid("attachment_file_id").unique(),
    attachmentFilePurpose: text("attachment_file_purpose").$type<PrivateFilePurpose>(),
    // Forced to now() (the transaction start) on insert: lines may only be added in the same
    // transaction that created the entry.
    ...createdAtOnly(),
  },
  (table) => [
    foreignKey({ columns: [table.reversesEntryId], foreignColumns: [table.id], name: "journal_entries_reverses_entry_id_fk" })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({ columns: [table.reversedByEntryId], foreignColumns: [table.id], name: "journal_entries_reversed_by_entry_id_fk" })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      columns: [table.attachmentFileId, table.attachmentFilePurpose],
      foreignColumns: [privateFiles.id, privateFiles.purpose],
      name: "journal_entries_attachment_file_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    // D-22 (Session 4): the books have exactly one active opening journal, dated the cut-over day.
    // A wrong one is reversed and entered again (the reversal frees this index).
    uniqueIndex("journal_entries_one_active_opening")
      .on(table.kind)
      .where(sql`${table.kind} = 'opening' and ${table.reversedByEntryId} is null`),
    // At most one active journal per posting key; superseded ones stay with their reversal.
    uniqueIndex("journal_entries_active_source_key")
      .on(table.sourceType, table.sourceId, table.sourceEvent)
      .where(sql`${table.sourceType} is not null and ${table.reversedByEntryId} is null and ${table.kind} <> 'reversal'`),
    index("journal_entries_entry_date_idx").on(table.entryDate),
    index("journal_entries_source_idx").on(table.sourceType, table.sourceId),
    index("journal_entries_posted_by_staff_user_id_idx").on(table.postedByStaffUserId),
    check("journal_entries_entry_no_check", sql`${table.entryNo} ~ '^JU-[0-9]{6}-[0-9]{4,}$'`),
    check("journal_entries_kind_check", checkIn(table.kind, JOURNAL_ENTRY_KINDS)),
    check(
      "journal_entries_source_key_check",
      sql`(${table.sourceType} is null and ${table.sourceId} is null and ${table.sourceEvent} is null)
        or (${table.sourceType} ~ '^[a-z][a-z0-9_]{0,39}$' and btrim(${table.sourceId}) <> '' and char_length(${table.sourceId}) <= 100
            and ${table.sourceEvent} ~ '^[a-z0-9][a-z0-9_:-]{0,39}$')`,
    ),
    // A system journal always names its source and the rule version that produced it.
    check("journal_entries_system_source_check", sql`${table.kind} <> 'system' or (${table.sourceType} is not null and ${table.ruleVersion} is not null)`),
    check("journal_entries_rule_version_check", sql`${table.ruleVersion} is null or ${table.ruleVersion} >= 1`),
    check("journal_entries_reversal_check", sql`(${table.kind} = 'reversal') = (${table.reversesEntryId} is not null)`),
    check(
      "journal_entries_not_self_check",
      sql`${table.reversesEntryId} is distinct from ${table.id} and ${table.reversedByEntryId} is distinct from ${table.id}`,
    ),
    // Manual and opening journals are always someone's.
    check("journal_entries_manual_actor_check", sql`${table.kind} not in ('manual', 'opening') or ${table.postedByStaffUserId} is not null`),
    check("journal_entries_description_check", sql`btrim(${table.description}) <> '' and char_length(${table.description}) <= 500`),
    check("journal_entries_opening_date_check", sql`${table.kind} <> 'opening' or ${table.entryDate} = ${sql.raw(`'${ACCOUNTING_CUTOVER_DATE}'`)}`),
    check(
      "journal_entries_attachment_check",
      sql`(${table.attachmentFileId} is null) = (${table.attachmentFilePurpose} is null)
        and (${table.attachmentFilePurpose} is null or (${table.attachmentFilePurpose} = 'journal_attachment' and ${table.kind} in ('manual', 'opening')))`,
    ),
    check("journal_entries_content_hash_check", sql`${table.contentHash} is null or ${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "restrict", onUpdate: "restrict" }),
    lineNo: integer("line_no").notNull(),
    accountCode: text("account_code")
      .notNull()
      .references(() => accounts.code, { onDelete: "restrict", onUpdate: "restrict" }),
    // Whole rupiah; exactly one side is positive.
    debit: bigint("debit", { mode: "number" }).notNull().default(0),
    credit: bigint("credit", { mode: "number" }).notNull().default(0),
    memo: text("memo"),
    // Dimensions, where known (sub-ledgers by channel, supplier, order, cash account).
    channelId: text("channel_id")
      .$type<ChannelId>()
      .references(() => channels.id, { onDelete: "restrict" }),
    supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    cashAccountCode: text("cash_account_code").references(() => accounts.code, { onDelete: "restrict", onUpdate: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.lineNo], name: "journal_lines_pkey" }),
    index("journal_lines_account_code_idx").on(table.accountCode),
    index("journal_lines_channel_id_idx").on(table.channelId),
    index("journal_lines_supplier_id_idx").on(table.supplierId),
    index("journal_lines_order_id_idx").on(table.orderId),
    index("journal_lines_cash_account_code_idx").on(table.cashAccountCode),
    check("journal_lines_line_no_check", sql`${table.lineNo} >= 1`),
    check("journal_lines_amount_check", sql`${table.debit} >= 0 and ${table.credit} >= 0 and ((${table.debit} > 0) <> (${table.credit} > 0))`),
    check("journal_lines_memo_check", sql`${table.memo} is null or (btrim(${table.memo}) <> '' and char_length(${table.memo}) <= 500)`),
  ],
);

export const postingRuns = pgTable(
  "posting_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trigger: text("trigger").$type<PostingRunTrigger>().notNull(),
    triggeredByStaffUserId: uuid("triggered_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    status: text("status").$type<PostingRunStatus>().notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    insertedCount: integer("inserted_count").notNull().default(0),
    reversedCount: integer("reversed_count").notNull().default(0),
    unchangedCount: integer("unchanged_count").notNull().default(0),
    issueCount: integer("issue_count").notNull().default(0),
    error: text("error"),
  },
  (table) => [
    index("posting_runs_started_at_idx").on(table.startedAt),
    index("posting_runs_triggered_by_staff_user_id_idx").on(table.triggeredByStaffUserId),
    check("posting_runs_trigger_check", checkIn(table.trigger, POSTING_RUN_TRIGGERS)),
    check("posting_runs_status_check", checkIn(table.status, POSTING_RUN_STATUSES)),
    check("posting_runs_manual_actor_check", sql`${table.trigger} <> 'manual' or ${table.triggeredByStaffUserId} is not null`),
    check("posting_runs_finished_check", sql`(${table.status} = 'running') = (${table.finishedAt} is null) and (${table.finishedAt} is null or ${table.finishedAt} >= ${table.startedAt})`),
    check(
      "posting_runs_counts_check",
      sql`${table.insertedCount} >= 0 and ${table.reversedCount} >= 0 and ${table.unchangedCount} >= 0 and ${table.issueCount} >= 0`,
    ),
    check("posting_runs_error_check", sql`(${table.status} = 'failed') = (${table.error} is not null)`),
  ],
);

export const postingIssues = pgTable(
  "posting_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceEvent: text("source_event").notNull(),
    // The source event's own Jakarta date, so month close can find the month's open issues.
    sourceDate: date("source_date", { mode: "string" }),
    // "unmapped_expense_category", "missing_marketplace_ship_date", ... (UI text in apps/admin).
    issueCode: text("issue_code").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    lastRunId: uuid("last_run_id").references(() => postingRuns.id, { onDelete: "restrict" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    // One open issue per (key, code): a re-run refreshes last_seen_at instead of duplicating.
    uniqueIndex("posting_issues_open_key")
      .on(table.sourceType, table.sourceId, table.sourceEvent, table.issueCode)
      .where(sql`${table.resolvedAt} is null`),
    index("posting_issues_open_source_date_idx").on(table.sourceDate).where(sql`${table.resolvedAt} is null`),
    index("posting_issues_last_run_id_idx").on(table.lastRunId),
    check("posting_issues_source_type_check", sql`${table.sourceType} ~ '^[a-z][a-z0-9_]{0,39}$'`),
    check("posting_issues_source_id_check", sql`btrim(${table.sourceId}) <> '' and char_length(${table.sourceId}) <= 100`),
    check("posting_issues_source_event_check", sql`${table.sourceEvent} ~ '^[a-z0-9][a-z0-9_:-]{0,39}$'`),
    check("posting_issues_issue_code_check", sql`${table.issueCode} ~ '^[a-z][a-z0-9_]{0,59}$'`),
    check("posting_issues_seen_check", sql`${table.lastSeenAt} >= ${table.firstSeenAt}`),
    check("posting_issues_resolved_check", sql`${table.resolvedAt} is null or ${table.resolvedAt} >= ${table.firstSeenAt}`),
  ],
);

export const taxSettings = pgTable(
  "tax_settings",
  {
    // The row in force for a month is the latest effective_from on or before it (D-20).
    effectiveFrom: date("effective_from", { mode: "string" }).primaryKey(),
    taxpayerType: text("taxpayer_type").$type<TaxpayerType>().notNull(),
    taxpayerLabel: text("taxpayer_label").notNull(),
    npwpRegisteredYear: integer("npwp_registered_year"),
    // Basis points: 50 = 0,5%.
    rateBps: integer("rate_bps").notNull(),
    // Whole rupiah of yearly gross sales that are tax-free (Rp500 juta).
    annualExemptionAmount: bigint("annual_exemption_amount", { mode: "number" }).notNull(),
    // Last day the rate applies; NULL = no end. After it no accrual is proposed and close warns.
    rateValidUntil: date("rate_valid_until", { mode: "string" }),
    note: text("note"),
    updatedByStaffUserId: uuid("updated_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (table) => [
    index("tax_settings_updated_by_staff_user_id_idx").on(table.updatedByStaffUserId),
    check("tax_settings_effective_from_check", sql`extract(day from ${table.effectiveFrom}) = 1`),
    check("tax_settings_taxpayer_type_check", checkIn(table.taxpayerType, TAXPAYER_TYPES)),
    check("tax_settings_taxpayer_label_check", sql`btrim(${table.taxpayerLabel}) <> '' and char_length(${table.taxpayerLabel}) <= 120`),
    check("tax_settings_npwp_year_check", sql`${table.npwpRegisteredYear} is null or ${table.npwpRegisteredYear} between 1980 and 2100`),
    check("tax_settings_rate_bps_check", sql`${table.rateBps} between 0 and 10000`),
    check("tax_settings_exemption_check", sql`${table.annualExemptionAmount} >= 0`),
    check("tax_settings_valid_until_check", sql`${table.rateValidUntil} is null or ${table.rateValidUntil} >= ${table.effectiveFrom}`),
    check("tax_settings_note_check", sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= 500)`),
  ],
);

// ---------- Pembayaran pesanan manual, migration 0053 ----------
// docs/plans/accounting.md §8 Session 6, D-3: how a manual order (any non-checkout,
// non-marketplace order) was paid and into which Kas & Bank account the money went, so rule S6
// (Session 9) posts it there instead of guessing. One row per order, written by the order form
// (in the order's own transaction), by "Siap Kirim" on an order waiting for payment (with the
// transition), or by "Isi cara bayar" for an older order; a correction overwrites it (audited).
// Hand-authored trigger order_manual_payments_guard (0053): only a manual order whose stock has
// left (it reached "Siap Kirim", so it was paid, D-3) gets a row; the account is read FOR SHARE
// and must be an active, postable Kas & Bank account (same race reasoning as
// account_mappings_guard_target); order_id never changes. An order without a row is a posting
// issue for S6, never a default account.
export const orderManualPayments = pgTable(
  "order_manual_payments",
  {
    orderId: uuid("order_id")
      .primaryKey()
      .references(() => orders.id, { onDelete: "restrict", onUpdate: "restrict" }),
    method: text("method").$type<ManualOrderPaymentMethod>().notNull(),
    cashAccountCode: text("cash_account_code")
      .notNull()
      .references(() => accounts.code, { onDelete: "restrict", onUpdate: "restrict" }),
    // The Jakarta calendar day the money came in, as staff recorded it.
    paidOn: date("paid_on", { mode: "string" }).notNull(),
    // Whoever recorded or last changed it; created_at/updated_at say when.
    recordedByStaffUserId: uuid("recorded_by_staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (table) => [
    index("order_manual_payments_cash_account_code_idx").on(table.cashAccountCode),
    index("order_manual_payments_recorded_by_staff_user_id_idx").on(table.recordedByStaffUserId),
    check("order_manual_payments_method_check", checkIn(table.method, MANUAL_ORDER_PAYMENT_METHODS)),
    check("order_manual_payments_cash_account_check", sql`${table.cashAccountCode} ~ ${sql.raw(`'${CASH_BANK_ACCOUNT_CODE_PATTERN}'`)}`),
  ],
);
