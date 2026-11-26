-- Migration 0049: Akuntansi, buku besar berpasangan (docs/plans/accounting.md §2.1, Session 1;
-- decisions D-1..D-25 in docs/plans/accounting-decisions.md). EXPAND-ONLY: eight new tables, their
-- triggers, reference rows and three permissions. Nothing existing is altered and no existing write
-- path reads or writes these tables, so the previous release runs unchanged against this schema.
-- drizzle-kit's statements first, then hand-authored: reference rows (Chart of Accounts §3,
-- initial mappings, the PPh final setting, permissions), then the triggers (drizzle-kit emits
-- none).

CREATE TABLE "account_mappings" (
	"mapping_key" text PRIMARY KEY NOT NULL,
	"account_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_mappings_key_check" CHECK ("account_mappings"."mapping_key" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)+$' and char_length("account_mappings"."mapping_key") <= 120)
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"code" text PRIMARY KEY NOT NULL,
	"name" "citext" NOT NULL,
	"type" text NOT NULL,
	"normal_balance" text NOT NULL,
	"parent_code" text,
	"is_header" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"system_key" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"cash_flow_group" text DEFAULT 'none' NOT NULL,
	"bank_name" text,
	"account_no_last4" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_name_unique" UNIQUE("name"),
	CONSTRAINT "accounts_system_key_unique" UNIQUE("system_key"),
	CONSTRAINT "accounts_code_check" CHECK ("accounts"."code" ~ '^[1-9]-[0-9]{4}$'),
	CONSTRAINT "accounts_name_check" CHECK (btrim("accounts"."name"::text) <> '' and char_length("accounts"."name"::text) <= 80),
	CONSTRAINT "accounts_type_check" CHECK ("accounts"."type" in ('asset', 'liability', 'equity', 'revenue', 'contra_revenue', 'cogs', 'expense', 'other_income', 'other_expense', 'tax')),
	CONSTRAINT "accounts_normal_balance_check" CHECK ("accounts"."normal_balance" in ('debit', 'credit')),
	CONSTRAINT "accounts_cash_flow_group_check" CHECK ("accounts"."cash_flow_group" in ('operating', 'investing', 'financing', 'cash', 'none')),
	CONSTRAINT "accounts_parent_not_self_check" CHECK ("accounts"."parent_code" is null or "accounts"."parent_code" <> "accounts"."code"),
	CONSTRAINT "accounts_system_key_check" CHECK (("accounts"."system_key" is not null) = "accounts"."is_system"),
	CONSTRAINT "accounts_system_key_format_check" CHECK ("accounts"."system_key" is null or "accounts"."system_key" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
	CONSTRAINT "accounts_system_postable_check" CHECK (not ("accounts"."is_system" and "accounts"."is_header")),
	CONSTRAINT "accounts_system_active_check" CHECK ("accounts"."is_active" or not "accounts"."is_system"),
	CONSTRAINT "accounts_bank_name_check" CHECK ("accounts"."bank_name" is null or (btrim("accounts"."bank_name") <> '' and char_length("accounts"."bank_name") <= 60)),
	CONSTRAINT "accounts_account_no_last4_check" CHECK ("accounts"."account_no_last4" is null or "accounts"."account_no_last4" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE "fiscal_periods" (
	"month" date PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_staff_user_id" uuid,
	"reopened_at" timestamp with time zone,
	"reopened_by_staff_user_id" uuid,
	"reopened_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_periods_month_check" CHECK (extract(day from "fiscal_periods"."month") = 1),
	CONSTRAINT "fiscal_periods_status_check" CHECK ("fiscal_periods"."status" in ('open', 'closed')),
	CONSTRAINT "fiscal_periods_closed_stamp_check" CHECK ("fiscal_periods"."status" <> 'closed' or ("fiscal_periods"."closed_at" is not null and "fiscal_periods"."closed_by_staff_user_id" is not null)),
	CONSTRAINT "fiscal_periods_reopen_stamp_check" CHECK (("fiscal_periods"."reopened_at" is null and "fiscal_periods"."reopened_by_staff_user_id" is null and "fiscal_periods"."reopened_reason" is null)
        or ("fiscal_periods"."reopened_at" is not null and "fiscal_periods"."reopened_by_staff_user_id" is not null
            and "fiscal_periods"."reopened_reason" is not null and btrim("fiscal_periods"."reopened_reason") <> '' and char_length("fiscal_periods"."reopened_reason") <= 500)),
	CONSTRAINT "fiscal_periods_trial_month_open_check" CHECK (not ("fiscal_periods"."month" = '2026-12-01' and "fiscal_periods"."status" = 'closed'))
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_no" text NOT NULL,
	"entry_date" date NOT NULL,
	"source_date" date,
	"source_type" text,
	"source_id" text,
	"source_event" text,
	"rule_version" integer,
	"kind" text NOT NULL,
	"reverses_entry_id" uuid,
	"reversed_by_entry_id" uuid,
	"description" text NOT NULL,
	"posted_by_staff_user_id" uuid,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_entry_no_unique" UNIQUE("entry_no"),
	CONSTRAINT "journal_entries_reverses_entry_id_unique" UNIQUE("reverses_entry_id"),
	CONSTRAINT "journal_entries_reversed_by_entry_id_unique" UNIQUE("reversed_by_entry_id"),
	CONSTRAINT "journal_entries_entry_no_check" CHECK ("journal_entries"."entry_no" ~ '^JU-[0-9]{6}-[0-9]{4,}$'),
	CONSTRAINT "journal_entries_kind_check" CHECK ("journal_entries"."kind" in ('system', 'manual', 'opening', 'reversal', 'closing', 'depreciation')),
	CONSTRAINT "journal_entries_source_key_check" CHECK (("journal_entries"."source_type" is null and "journal_entries"."source_id" is null and "journal_entries"."source_event" is null)
        or ("journal_entries"."source_type" ~ '^[a-z][a-z0-9_]{0,39}$' and btrim("journal_entries"."source_id") <> '' and char_length("journal_entries"."source_id") <= 100
            and "journal_entries"."source_event" ~ '^[a-z0-9][a-z0-9_:-]{0,39}$')),
	CONSTRAINT "journal_entries_system_source_check" CHECK ("journal_entries"."kind" <> 'system' or ("journal_entries"."source_type" is not null and "journal_entries"."rule_version" is not null)),
	CONSTRAINT "journal_entries_rule_version_check" CHECK ("journal_entries"."rule_version" is null or "journal_entries"."rule_version" >= 1),
	CONSTRAINT "journal_entries_reversal_check" CHECK (("journal_entries"."kind" = 'reversal') = ("journal_entries"."reverses_entry_id" is not null)),
	CONSTRAINT "journal_entries_not_self_check" CHECK ("journal_entries"."reverses_entry_id" is distinct from "journal_entries"."id" and "journal_entries"."reversed_by_entry_id" is distinct from "journal_entries"."id"),
	CONSTRAINT "journal_entries_manual_actor_check" CHECK ("journal_entries"."kind" not in ('manual', 'opening') or "journal_entries"."posted_by_staff_user_id" is not null),
	CONSTRAINT "journal_entries_description_check" CHECK (btrim("journal_entries"."description") <> '' and char_length("journal_entries"."description") <= 500),
	CONSTRAINT "journal_entries_content_hash_check" CHECK ("journal_entries"."content_hash" is null or "journal_entries"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_code" text NOT NULL,
	"debit" bigint DEFAULT 0 NOT NULL,
	"credit" bigint DEFAULT 0 NOT NULL,
	"memo" text,
	"channel_id" text,
	"supplier_id" uuid,
	"order_id" uuid,
	"cash_account_code" text,
	CONSTRAINT "journal_lines_pkey" PRIMARY KEY("entry_id","line_no"),
	CONSTRAINT "journal_lines_line_no_check" CHECK ("journal_lines"."line_no" >= 1),
	CONSTRAINT "journal_lines_amount_check" CHECK ("journal_lines"."debit" >= 0 and "journal_lines"."credit" >= 0 and (("journal_lines"."debit" > 0) <> ("journal_lines"."credit" > 0))),
	CONSTRAINT "journal_lines_memo_check" CHECK ("journal_lines"."memo" is null or (btrim("journal_lines"."memo") <> '' and char_length("journal_lines"."memo") <= 500))
);
--> statement-breakpoint
CREATE TABLE "posting_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"source_event" text NOT NULL,
	"source_date" date,
	"issue_code" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_id" uuid,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "posting_issues_source_type_check" CHECK ("posting_issues"."source_type" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "posting_issues_source_id_check" CHECK (btrim("posting_issues"."source_id") <> '' and char_length("posting_issues"."source_id") <= 100),
	CONSTRAINT "posting_issues_source_event_check" CHECK ("posting_issues"."source_event" ~ '^[a-z0-9][a-z0-9_:-]{0,39}$'),
	CONSTRAINT "posting_issues_issue_code_check" CHECK ("posting_issues"."issue_code" ~ '^[a-z][a-z0-9_]{0,59}$'),
	CONSTRAINT "posting_issues_seen_check" CHECK ("posting_issues"."last_seen_at" >= "posting_issues"."first_seen_at"),
	CONSTRAINT "posting_issues_resolved_check" CHECK ("posting_issues"."resolved_at" is null or "posting_issues"."resolved_at" >= "posting_issues"."first_seen_at")
);
--> statement-breakpoint
CREATE TABLE "posting_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"triggered_by_staff_user_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"inserted_count" integer DEFAULT 0 NOT NULL,
	"reversed_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"issue_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "posting_runs_trigger_check" CHECK ("posting_runs"."trigger" in ('cron', 'manual')),
	CONSTRAINT "posting_runs_status_check" CHECK ("posting_runs"."status" in ('running', 'succeeded', 'failed')),
	CONSTRAINT "posting_runs_manual_actor_check" CHECK ("posting_runs"."trigger" <> 'manual' or "posting_runs"."triggered_by_staff_user_id" is not null),
	CONSTRAINT "posting_runs_finished_check" CHECK (("posting_runs"."status" = 'running') = ("posting_runs"."finished_at" is null) and ("posting_runs"."finished_at" is null or "posting_runs"."finished_at" >= "posting_runs"."started_at")),
	CONSTRAINT "posting_runs_counts_check" CHECK ("posting_runs"."inserted_count" >= 0 and "posting_runs"."reversed_count" >= 0 and "posting_runs"."unchanged_count" >= 0 and "posting_runs"."issue_count" >= 0),
	CONSTRAINT "posting_runs_error_check" CHECK (("posting_runs"."status" = 'failed') = ("posting_runs"."error" is not null))
);
--> statement-breakpoint
CREATE TABLE "tax_settings" (
	"effective_from" date PRIMARY KEY NOT NULL,
	"taxpayer_type" text NOT NULL,
	"taxpayer_label" text NOT NULL,
	"npwp_registered_year" integer,
	"rate_bps" integer NOT NULL,
	"annual_exemption_amount" bigint NOT NULL,
	"rate_valid_until" date,
	"note" text,
	"updated_by_staff_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_settings_effective_from_check" CHECK (extract(day from "tax_settings"."effective_from") = 1),
	CONSTRAINT "tax_settings_taxpayer_type_check" CHECK ("tax_settings"."taxpayer_type" in ('individual', 'company')),
	CONSTRAINT "tax_settings_taxpayer_label_check" CHECK (btrim("tax_settings"."taxpayer_label") <> '' and char_length("tax_settings"."taxpayer_label") <= 120),
	CONSTRAINT "tax_settings_npwp_year_check" CHECK ("tax_settings"."npwp_registered_year" is null or "tax_settings"."npwp_registered_year" between 1980 and 2100),
	CONSTRAINT "tax_settings_rate_bps_check" CHECK ("tax_settings"."rate_bps" between 0 and 10000),
	CONSTRAINT "tax_settings_exemption_check" CHECK ("tax_settings"."annual_exemption_amount" >= 0),
	CONSTRAINT "tax_settings_valid_until_check" CHECK ("tax_settings"."rate_valid_until" is null or "tax_settings"."rate_valid_until" >= "tax_settings"."effective_from"),
	CONSTRAINT "tax_settings_note_check" CHECK ("tax_settings"."note" is null or (btrim("tax_settings"."note") <> '' and char_length("tax_settings"."note") <= 500))
);
--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_account_code_accounts_code_fk" FOREIGN KEY ("account_code") REFERENCES "public"."accounts"("code") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_code_accounts_code_fk" FOREIGN KEY ("parent_code") REFERENCES "public"."accounts"("code") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_closed_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("closed_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_reopened_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("reopened_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("posted_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_entry_id_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversed_by_entry_id_fk" FOREIGN KEY ("reversed_by_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_code_accounts_code_fk" FOREIGN KEY ("account_code") REFERENCES "public"."accounts"("code") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_cash_account_code_accounts_code_fk" FOREIGN KEY ("cash_account_code") REFERENCES "public"."accounts"("code") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "posting_issues" ADD CONSTRAINT "posting_issues_last_run_id_posting_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."posting_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_runs" ADD CONSTRAINT "posting_runs_triggered_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("triggered_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_settings" ADD CONSTRAINT "tax_settings_updated_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("updated_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_mappings_account_code_idx" ON "account_mappings" USING btree ("account_code");--> statement-breakpoint
CREATE INDEX "accounts_parent_code_idx" ON "accounts" USING btree ("parent_code");--> statement-breakpoint
CREATE INDEX "fiscal_periods_closed_by_staff_user_id_idx" ON "fiscal_periods" USING btree ("closed_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "fiscal_periods_reopened_by_staff_user_id_idx" ON "fiscal_periods" USING btree ("reopened_by_staff_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_active_source_key" ON "journal_entries" USING btree ("source_type","source_id","source_event") WHERE "journal_entries"."source_type" is not null and "journal_entries"."reversed_by_entry_id" is null and "journal_entries"."kind" <> 'reversal';--> statement-breakpoint
CREATE INDEX "journal_entries_entry_date_idx" ON "journal_entries" USING btree ("entry_date");--> statement-breakpoint
CREATE INDEX "journal_entries_source_idx" ON "journal_entries" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "journal_entries_posted_by_staff_user_id_idx" ON "journal_entries" USING btree ("posted_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "journal_lines_account_code_idx" ON "journal_lines" USING btree ("account_code");--> statement-breakpoint
CREATE INDEX "journal_lines_channel_id_idx" ON "journal_lines" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "journal_lines_supplier_id_idx" ON "journal_lines" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "journal_lines_order_id_idx" ON "journal_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "journal_lines_cash_account_code_idx" ON "journal_lines" USING btree ("cash_account_code");--> statement-breakpoint
CREATE UNIQUE INDEX "posting_issues_open_key" ON "posting_issues" USING btree ("source_type","source_id","source_event","issue_code") WHERE "posting_issues"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "posting_issues_open_source_date_idx" ON "posting_issues" USING btree ("source_date") WHERE "posting_issues"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "posting_issues_last_run_id_idx" ON "posting_issues" USING btree ("last_run_id");--> statement-breakpoint
CREATE INDEX "posting_runs_started_at_idx" ON "posting_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "posting_runs_triggered_by_staff_user_id_idx" ON "posting_runs" USING btree ("triggered_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "tax_settings_updated_by_staff_user_id_idx" ON "tax_settings" USING btree ("updated_by_staff_user_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Hand-authored from here.
-- ---------------------------------------------------------------------------------------------

-- Reference rows the posting rules match by literal (system_key, mapping_key), so they ship here
-- (CLAUDE.md DB rule); seed.ts repeats them insert-only for databases reset by TRUNCATE.
-- migration-0049.test.ts asserts they equal CHART_OF_ACCOUNTS / DEFAULT_ACCOUNT_MAPPINGS /
-- INITIAL_TAX_SETTING (packages/db/src/accounting/chart-of-accounts.ts). ON CONFLICT DO NOTHING
-- never overwrites the accountant's later rename or re-mapping. Parents precede children.
INSERT INTO "accounts" ("code", "name", "type", "normal_balance", "parent_code", "is_header", "is_system", "system_key", "cash_flow_group", "sort_order") VALUES
  ('1-1000', 'Aset lancar', 'asset', 'debit', NULL, true, false, NULL, 'none', 10),
  ('1-1100', 'Kas', 'asset', 'debit', '1-1000', true, false, NULL, 'none', 20),
  ('1-1101', 'Kas tunai', 'asset', 'debit', '1-1100', false, true, 'cash.on_hand', 'cash', 30),
  ('1-1200', 'Bank', 'asset', 'debit', '1-1000', true, false, NULL, 'none', 40),
  ('1-1201', 'Bank utama', 'asset', 'debit', '1-1200', false, true, 'bank.main', 'cash', 50),
  ('1-1300', 'Saldo pembayaran & marketplace', 'asset', 'debit', '1-1000', true, false, NULL, 'none', 60),
  ('1-1301', 'Piutang Midtrans', 'asset', 'debit', '1-1300', false, true, 'receivable.midtrans', 'cash', 70),
  ('1-1302', 'Saldo Penjual Shopee', 'asset', 'debit', '1-1300', false, true, 'seller_balance.shopee', 'cash', 80),
  ('1-1303', 'Saldo Penjual TikTok', 'asset', 'debit', '1-1300', false, true, 'seller_balance.tiktok', 'cash', 90),
  ('1-1305', 'Saldo marketplace belum dipilah', 'asset', 'debit', '1-1300', false, true, 'seller_balance.unallocated', 'cash', 100),
  ('1-1400', 'Piutang', 'asset', 'debit', '1-1000', true, false, NULL, 'none', 110),
  ('1-1402', 'Piutang klaim pemasok (lebih bayar)', 'asset', 'debit', '1-1400', false, true, 'receivable.supplier_claim', 'operating', 120),
  ('1-1409', 'Piutang lain-lain', 'asset', 'debit', '1-1400', false, false, NULL, 'operating', 130),
  ('1-1500', 'Persediaan', 'asset', 'debit', '1-1000', true, false, NULL, 'none', 140),
  ('1-1501', 'Persediaan bahan kain', 'asset', 'debit', '1-1500', false, true, 'inventory.fabric', 'operating', 150),
  ('1-1502', 'Persediaan aksesoris', 'asset', 'debit', '1-1500', false, true, 'inventory.accessory', 'operating', 160),
  ('1-1503', 'Barang dalam proses (produksi)', 'asset', 'debit', '1-1500', false, true, 'inventory.wip', 'operating', 170),
  ('1-1504', 'Persediaan barang jadi', 'asset', 'debit', '1-1500', false, true, 'inventory.finished_goods', 'operating', 180),
  ('1-1505', 'Barang terjual belum dikirim', 'asset', 'debit', '1-1500', false, true, 'inventory.sold_not_shipped', 'operating', 190),
  ('1-1506', 'Persediaan barang cacat', 'asset', 'debit', '1-1500', false, true, 'inventory.defect', 'operating', 200),
  ('1-1600', 'Uang muka & dibayar di muka', 'asset', 'debit', '1-1000', true, false, NULL, 'none', 210),
  ('1-1601', 'Uang muka pembelian', 'asset', 'debit', '1-1600', false, true, 'prepaid.purchase_advance', 'operating', 220),
  ('1-1602', 'Sewa dibayar di muka', 'asset', 'debit', '1-1600', false, false, NULL, 'operating', 230),
  ('1-1603', 'Saldo Biteship (uang muka ongkir)', 'asset', 'debit', '1-1600', false, true, 'prepaid.biteship', 'operating', 240),
  ('1-2000', 'Aset tetap', 'asset', 'debit', NULL, true, false, NULL, 'none', 250),
  ('1-2101', 'Mesin & peralatan produksi', 'asset', 'debit', '1-2000', false, false, NULL, 'investing', 260),
  ('1-2102', 'Peralatan kantor & komputer', 'asset', 'debit', '1-2000', false, false, NULL, 'investing', 270),
  ('1-2103', 'Kendaraan', 'asset', 'debit', '1-2000', false, false, NULL, 'investing', 280),
  ('1-2104', 'Bangunan/renovasi', 'asset', 'debit', '1-2000', false, false, NULL, 'investing', 290),
  ('1-2191', 'Akumulasi penyusutan mesin & peralatan produksi', 'asset', 'credit', '1-2000', false, false, NULL, 'investing', 300),
  ('1-2192', 'Akumulasi penyusutan peralatan kantor & komputer', 'asset', 'credit', '1-2000', false, false, NULL, 'investing', 310),
  ('1-2193', 'Akumulasi penyusutan kendaraan', 'asset', 'credit', '1-2000', false, false, NULL, 'investing', 320),
  ('1-2194', 'Akumulasi penyusutan bangunan/renovasi', 'asset', 'credit', '1-2000', false, false, NULL, 'investing', 330),
  ('2-1101', 'Utang usaha pemasok bahan', 'liability', 'credit', NULL, false, true, 'payable.material_supplier', 'operating', 340),
  ('2-1102', 'Utang usaha jasa produksi', 'liability', 'credit', NULL, false, true, 'payable.production_service', 'operating', 350),
  ('2-1103', 'Utang usaha tanpa pemasok', 'liability', 'credit', NULL, false, true, 'payable.no_supplier', 'operating', 360),
  ('2-1201', 'Uang muka pelanggan', 'liability', 'credit', NULL, false, true, 'liability.customer_deposit', 'operating', 370),
  ('2-1202', 'Utang pengembalian dana pelanggan', 'liability', 'credit', NULL, false, true, 'liability.customer_refund', 'operating', 380),
  ('2-1203', 'Titipan ongkir pembeli', 'liability', 'credit', NULL, false, true, 'liability.buyer_shipping', 'operating', 390),
  ('2-1401', 'Utang PPh final', 'liability', 'credit', NULL, false, true, 'liability.pph_final', 'operating', 400),
  ('2-1402', 'Biaya masih harus dibayar', 'liability', 'credit', NULL, false, false, NULL, 'operating', 410),
  ('2-2101', 'Utang bank/pinjaman', 'liability', 'credit', NULL, false, false, NULL, 'financing', 420),
  ('2-2201', 'Pinjaman dari pemilik', 'liability', 'credit', NULL, false, false, NULL, 'financing', 430),
  ('3-1001', 'Modal pemilik', 'equity', 'credit', NULL, false, true, 'equity.owner_capital', 'financing', 440),
  ('3-1002', 'Prive', 'equity', 'debit', NULL, false, true, 'equity.drawings', 'financing', 450),
  ('3-2001', 'Saldo laba', 'equity', 'credit', NULL, false, true, 'equity.retained_earnings', 'none', 460),
  ('3-2002', 'Laba (rugi) tahun berjalan', 'equity', 'credit', NULL, false, true, 'equity.current_year_earnings', 'none', 470),
  ('3-9001', 'Ekuitas saldo awal', 'equity', 'credit', NULL, false, true, 'equity.opening_balance', 'none', 480),
  ('4-1100', 'Penjualan', 'revenue', 'credit', NULL, true, false, NULL, 'none', 490),
  ('4-1101', 'Penjualan Website', 'revenue', 'credit', '4-1100', false, true, 'revenue.web', 'operating', 500),
  ('4-1102', 'Penjualan Shopee', 'revenue', 'credit', '4-1100', false, true, 'revenue.shopee', 'operating', 510),
  ('4-1103', 'Penjualan TikTok', 'revenue', 'credit', '4-1100', false, true, 'revenue.tiktok', 'operating', 520),
  ('4-1105', 'Penjualan WhatsApp/Instagram/Offline', 'revenue', 'credit', '4-1100', false, true, 'revenue.manual', 'operating', 530),
  ('4-1201', 'Potongan penjualan (voucher & diskon)', 'contra_revenue', 'debit', NULL, false, true, 'contra_revenue.sales_discount', 'operating', 540),
  ('4-1301', 'Retur penjualan', 'contra_revenue', 'debit', NULL, false, true, 'contra_revenue.sales_return', 'operating', 550),
  ('5-1101', 'HPP barang jadi', 'cogs', 'debit', NULL, false, true, 'cogs.finished_goods', 'operating', 560),
  ('5-1201', 'Selisih biaya produksi', 'cogs', 'debit', NULL, false, true, 'cogs.production_variance', 'operating', 570),
  ('6-1000', 'Beban penjualan & pemasaran', 'expense', 'debit', NULL, true, false, NULL, 'none', 580),
  ('6-1101', 'Iklan', 'expense', 'debit', '6-1000', false, false, NULL, 'operating', 590),
  ('6-1102', 'Endorse/KOL', 'expense', 'debit', '6-1000', false, false, NULL, 'operating', 600),
  ('6-1201', 'Biaya platform marketplace', 'expense', 'debit', '6-1000', false, true, 'expense.marketplace_fee', 'operating', 610),
  ('6-1202', 'Subsidi ongkir penjual (marketplace)', 'expense', 'debit', '6-1000', false, true, 'expense.marketplace_shipping_subsidy', 'operating', 620),
  ('6-1203', 'Biaya payment gateway', 'expense', 'debit', '6-1000', false, true, 'expense.payment_gateway', 'operating', 630),
  ('6-1301', 'Beban ongkos kirim penjualan', 'expense', 'debit', '6-1000', false, true, 'expense.sales_shipping', 'operating', 640),
  ('6-1302', 'Subsidi ongkir website', 'expense', 'debit', '6-1000', false, true, 'expense.web_shipping_subsidy', 'operating', 650),
  ('6-1401', 'Packaging', 'expense', 'debit', '6-1000', false, false, NULL, 'operating', 660),
  ('6-2000', 'Beban umum & administrasi', 'expense', 'debit', NULL, true, false, NULL, 'none', 670),
  ('6-2101', 'Gaji', 'expense', 'debit', '6-2000', false, false, NULL, 'operating', 680),
  ('6-2201', 'Sewa', 'expense', 'debit', '6-2000', false, false, NULL, 'operating', 690),
  ('6-2301', 'Utilitas', 'expense', 'debit', '6-2000', false, false, NULL, 'operating', 700),
  ('6-2401', 'Beban penyusutan', 'expense', 'debit', '6-2000', false, true, 'expense.depreciation', 'operating', 710),
  ('6-2501', 'Beban langganan aplikasi', 'expense', 'debit', '6-2000', false, true, 'expense.subscriptions', 'operating', 720),
  ('6-2901', 'Beban lain-lain', 'expense', 'debit', '6-2000', false, true, 'expense.other', 'operating', 730),
  ('6-3101', 'Ongkir bahan', 'expense', 'debit', NULL, false, false, NULL, 'operating', 740),
  ('6-4000', 'Beban persediaan', 'expense', 'debit', NULL, true, false, NULL, 'none', 750),
  ('6-4101', 'Selisih persediaan', 'expense', 'debit', '6-4000', false, true, 'expense.inventory_variance', 'operating', 760),
  ('6-4102', 'Kerusakan & kehilangan persediaan', 'expense', 'debit', '6-4000', false, true, 'expense.inventory_loss', 'operating', 770),
  ('6-4103', 'Barang cacat dilepas', 'expense', 'debit', '6-4000', false, true, 'expense.defect_release', 'operating', 780),
  ('7-1101', 'Hasil lelang barang cacat', 'other_income', 'credit', NULL, false, true, 'other_income.defect_auction', 'operating', 790),
  ('7-1102', 'Bunga bank', 'other_income', 'credit', NULL, false, false, NULL, 'operating', 800),
  ('7-1103', 'Selisih pembulatan/lain-lain', 'other_income', 'credit', NULL, false, false, NULL, 'operating', 810),
  ('8-1101', 'Administrasi bank', 'other_expense', 'debit', NULL, false, false, NULL, 'operating', 820),
  ('8-1102', 'Rugi pelepasan aset tetap', 'other_expense', 'debit', NULL, false, false, NULL, 'investing', 830),
  ('9-1101', 'Beban PPh final', 'tax', 'debit', NULL, false, true, 'tax.pph_final', 'operating', 840)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

INSERT INTO "account_mappings" ("mapping_key", "account_code") VALUES
  ('cash.method.cash', '1-1101'),
  ('cash.method.transfer', '1-1201'),
  ('cash.method.card', '1-1201'),
  ('cash.midtrans_payout', '1-1201'),
  ('revenue.channel.web', '4-1101'),
  ('revenue.channel.shopee', '4-1102'),
  ('revenue.channel.tiktok', '4-1103'),
  ('revenue.channel.whatsapp', '4-1105'),
  ('revenue.channel.instagram', '4-1105'),
  ('revenue.channel.offline', '4-1105'),
  ('revenue.channel.reseller', '4-1105'),
  ('expense.category.ads_meta', '6-1101'),
  ('expense.category.ads_tiktok', '6-1101'),
  ('expense.category.ads_shopee', '6-1101'),
  ('expense.category.endorsement', '6-1102'),
  ('expense.category.material_shipping', '6-3101'),
  ('expense.category.packaging', '6-1401'),
  ('expense.category.salary', '6-2101'),
  ('expense.category.rent', '6-2201'),
  ('expense.category.utilities', '6-2301'),
  ('expense.category.other', '6-2901'),
  ('supplier_payable.kind.material', '2-1101'),
  ('supplier_payable.kind.service', '2-1102'),
  ('supplier_payable.kind.no_supplier', '2-1103')
ON CONFLICT ("mapping_key") DO NOTHING;--> statement-breakpoint

-- D-20: the initial PPh final setting. The rate ends 2026-12-31 under the original PP 55/2022
-- (NPWP 2020) until the accountant enters the end date from the PP 55 revision.
INSERT INTO "tax_settings" ("effective_from", "taxpayer_type", "taxpayer_label", "npwp_registered_year", "rate_bps", "annual_exemption_amount", "rate_valid_until", "note") VALUES
  ('2026-12-01', 'individual', 'Istri pemilik, orang pribadi', 2020, 50, 500000000, '2026-12-31',
   'Tarif PPh final 0,5% (PP 55/2022). Perbarui tanggal akhir setelah revisi PP 55 dipastikan.')
ON CONFLICT ("effective_from") DO NOTHING;--> statement-breakpoint

-- Plan §7: three new permission keys (PERMISSIONS in packages/db/src/rbac/permissions.ts). Granted
-- to super_admin and owner (none is in OWNER_EXCLUDED_PERMISSION_KEYS); the predefined finance role
-- gets none by default: the books (owner capital, prive, bank balances) are more sensitive than the
-- management figures. Same idempotent pattern as 0012/0038.
INSERT INTO "permissions" ("key", "description", "group") VALUES
  ('accounting.view', 'View the books: journals, ledgers, financial statements and reconciliation', 'accounting'),
  ('accounting.manage', 'Manage the chart of accounts and mappings, manual and opening journals, fixed assets, tax settings, and run posting', 'accounting'),
  ('accounting.close', 'Close and reopen accounting periods, and run year-end closing', 'accounting')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r, "permissions" p
WHERE r."key" IN ('super_admin', 'owner') AND p."key" IN ('accounting.view', 'accounting.manage', 'accounting.close')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;--> statement-breakpoint

CREATE TRIGGER set_updated_at BEFORE UPDATE ON "accounts" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "account_mappings" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "fiscal_periods" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "tax_settings" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint

-- ---- accounts ----------------------------------------------------------------------------------
-- An account's identity never changes (plan §2.1: code, type, system_key; also normal_balance and
-- is_system, without which the system lock and report signs could be undone). Name, parent, order,
-- bank fields and (non-system) is_active stay editable. An account with journal lines cannot become
-- a header; an account a mapping points at cannot be deactivated; the parent chain has no cycle.
CREATE OR REPLACE FUNCTION accounts_guard_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.normal_balance IS DISTINCT FROM OLD.normal_balance OR NEW.is_system IS DISTINCT FROM OLD.is_system
     OR NEW.system_key IS DISTINCT FROM OLD.system_key THEN
    RAISE EXCEPTION 'accounts %: code, type, normal_balance, is_system and system_key are immutable', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.is_header AND NOT OLD.is_header
     AND EXISTS (SELECT 1 FROM journal_lines WHERE account_code = OLD.code OR cash_account_code = OLD.code) THEN
    RAISE EXCEPTION 'accounts %: an account with journal lines cannot become a header', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.is_active AND NOT NEW.is_active
     AND EXISTS (SELECT 1 FROM account_mappings WHERE account_code = OLD.code) THEN
    RAISE EXCEPTION 'accounts %: an account a mapping points at cannot be deactivated; re-map it first', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER accounts_guard_update BEFORE UPDATE ON "accounts" FOR EACH ROW
  EXECUTE FUNCTION accounts_guard_update();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounts_parent_no_cycle()
RETURNS trigger AS $$
BEGIN
  IF NEW.parent_code IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors(code) AS (
      SELECT NEW.parent_code
      UNION
      SELECT a.parent_code FROM accounts a JOIN ancestors ON a.code = ancestors.code WHERE a.parent_code IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE code = NEW.code
  ) THEN
    RAISE EXCEPTION 'accounts %: parent % would make a cycle', NEW.code, NEW.parent_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER accounts_parent_no_cycle BEFORE INSERT OR UPDATE OF "parent_code" ON "accounts" FOR EACH ROW
  EXECUTE FUNCTION accounts_parent_no_cycle();
--> statement-breakpoint

-- Never deleted: a system account (a posting rule names it), or any account a journal line uses
-- (as its account or its cash-account dimension). The FKs from journal_lines/account_mappings/
-- children are the backstop; this gives the reason. An unused, non-system account may be deleted.
CREATE OR REPLACE FUNCTION accounts_guard_delete()
RETURNS trigger AS $$
BEGIN
  IF OLD.is_system THEN
    RAISE EXCEPTION 'accounts %: system accounts are never deleted', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_lines WHERE account_code = OLD.code OR cash_account_code = OLD.code) THEN
    RAISE EXCEPTION 'accounts %: an account with journal lines is never deleted; deactivate it instead', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER accounts_guard_delete BEFORE DELETE ON "accounts" FOR EACH ROW
  EXECUTE FUNCTION accounts_guard_delete();
--> statement-breakpoint

-- ---- account_mappings --------------------------------------------------------------------------
-- A mapping points at an active, postable account. An unknown code is left to the FK. The account
-- row is read FOR SHARE, which conflicts with the row lock a concurrent deactivation takes: one waits
-- for the other and then sees its committed result, so the check can't pass on a stale read.
CREATE OR REPLACE FUNCTION account_mappings_guard_target()
RETURNS trigger AS $$
DECLARE
  target accounts%ROWTYPE;
BEGIN
  SELECT * INTO target FROM accounts WHERE code = NEW.account_code FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF target.is_header OR NOT target.is_active THEN
    RAISE EXCEPTION 'account_mappings %: target account % must be active and not a header', NEW.mapping_key, NEW.account_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER account_mappings_guard_target BEFORE INSERT OR UPDATE OF "account_code" ON "account_mappings" FOR EACH ROW
  EXECUTE FUNCTION account_mappings_guard_target();
--> statement-breakpoint

-- ---- period lock -------------------------------------------------------------------------------
-- Nothing is written into a closed month (plan §2, D-23). A post takes the month's advisory lock
-- SHARED; closing the month takes it EXCLUSIVE (fiscal_periods_close_lock below), so a close and a
-- concurrent post serialise: whichever commits second sees the other. This needs Read Committed,
-- where the status is read after the lock by a statement with its own fresh snapshot. Under
-- Repeatable Read or Serializable the read would use the transaction's snapshot, taken before a
-- close that committed while this post waited for the lock, and could see the month as still open;
-- so a write at any other isolation level is refused outright. No fiscal_periods row = open.
CREATE OR REPLACE FUNCTION accounting_period_lock_key(target date)
RETURNS integer AS $$
  SELECT (extract(year FROM target)::integer * 100 + extract(month FROM target)::integer);
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounting_assert_period_open(target date)
RETURNS void AS $$
DECLARE
  period_status text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'journals are written only at READ COMMITTED isolation (this transaction is %), so the closed-period check reads the current status', current_setting('transaction_isolation')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entries_period_open', TABLE = 'journal_entries';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtext('ammari.fiscal_period'), accounting_period_lock_key(target));
  SELECT status INTO period_status FROM fiscal_periods WHERE month = date_trunc('month', target)::date;
  IF period_status = 'closed' THEN
    RAISE EXCEPTION 'accounting period % is closed; date the entry in the first open month', to_char(target, 'YYYY-MM')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entries_period_open', TABLE = 'journal_entries';
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Closing takes the month's lock EXCLUSIVE (see above). A reopen must be stamped and reasoned.
CREATE OR REPLACE FUNCTION fiscal_periods_close_lock()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'closed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'closed') THEN
    PERFORM pg_advisory_xact_lock(hashtext('ammari.fiscal_period'), accounting_period_lock_key(NEW.month));
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.month IS DISTINCT FROM OLD.month THEN
    RAISE EXCEPTION 'fiscal_periods %: month is immutable', OLD.month
      USING ERRCODE = 'check_violation';
  END IF;
  -- D-23: every reopen carries its own new stamp (who, when, written reason). The CHECK alone
  -- would let a plain status = 'open' through with the stamp empty or left over from an earlier
  -- reopen.
  IF TG_OP = 'UPDATE' AND OLD.status = 'closed' AND NEW.status = 'open'
     AND (NEW.reopened_at IS NULL OR NEW.reopened_at IS NOT DISTINCT FROM OLD.reopened_at
          OR NEW.reopened_by_staff_user_id IS NULL
          OR NEW.reopened_reason IS NULL OR btrim(NEW.reopened_reason) = '') THEN
    RAISE EXCEPTION 'fiscal_periods %: reopening needs a new reopened_at, reopened_by_staff_user_id and a written reason', OLD.month
      USING ERRCODE = 'check_violation', CONSTRAINT = 'fiscal_periods_reopen_reason', TABLE = 'fiscal_periods';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER fiscal_periods_close_lock BEFORE INSERT OR UPDATE ON "fiscal_periods" FOR EACH ROW
  EXECUTE FUNCTION fiscal_periods_close_lock();
--> statement-breakpoint

-- A period is never deleted (its close/reopen history would go with it).
CREATE OR REPLACE FUNCTION prevent_accounting_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_fiscal_period_delete BEFORE DELETE ON "fiscal_periods" FOR EACH ROW
  EXECUTE FUNCTION prevent_accounting_delete();
--> statement-breakpoint

-- ---- journal_entries ---------------------------------------------------------------------------
-- On insert: created_at is the transaction start (lines may only join an entry in the transaction
-- that created it, journal_lines_guard_insert); the reversal stamp starts empty; the month is open;
-- a reversal never reverses a reversal (re-posting is reverse + a new entry, never re-reversal).
CREATE OR REPLACE FUNCTION journal_entries_guard_insert()
RETURNS trigger AS $$
BEGIN
  NEW.created_at := now();
  IF NEW.reversed_by_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'journal_entries: reversed_by_entry_id is stamped when the reversal is inserted, never on insert'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM accounting_assert_period_open(NEW.entry_date);
  IF NEW.kind = 'reversal' AND EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.reverses_entry_id AND kind = 'reversal') THEN
    RAISE EXCEPTION 'journal_entries: a reversal is never reversed (entry %)', NEW.reverses_entry_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER journal_entries_guard_insert BEFORE INSERT ON "journal_entries" FOR EACH ROW
  EXECUTE FUNCTION journal_entries_guard_insert();
--> statement-breakpoint

-- Append-only: never deleted; the only UPDATE is the one-time reversed_by_entry_id stamp, and it
-- must name this entry's own reversal. A wrong journal is corrected by reversal, never edited.
CREATE OR REPLACE FUNCTION journal_entries_guard_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal_entries is append-only; rows are never deleted (reverse instead)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.reversed_by_entry_id IS NOT NULL OR NEW.reversed_by_entry_id IS NULL
     OR (to_jsonb(NEW) - 'reversed_by_entry_id') IS DISTINCT FROM (to_jsonb(OLD) - 'reversed_by_entry_id') THEN
    RAISE EXCEPTION 'journal_entries is append-only; only reversed_by_entry_id may be set, once (entry %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.reversed_by_entry_id AND reverses_entry_id = OLD.id) THEN
    RAISE EXCEPTION 'journal_entries %: reversed_by_entry_id must be the entry that reverses it', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER journal_entries_guard_mutation BEFORE UPDATE OR DELETE ON "journal_entries" FOR EACH ROW
  EXECUTE FUNCTION journal_entries_guard_mutation();
--> statement-breakpoint

-- ---- journal_lines -----------------------------------------------------------------------------
-- On insert: only in the transaction that created the entry; the entry's month is still open; the
-- account (and the cash-account dimension) is active and postable. Unknown entry/account codes are
-- left to the FKs. Account rows are read FOR SHARE (same reason as account_mappings_guard_target):
-- a concurrent "make it a header" or deactivation waits for this line's transaction, then sees the
-- line; or this insert waits for that update and then sees the header/inactive flag.
CREATE OR REPLACE FUNCTION journal_lines_guard_insert()
RETURNS trigger AS $$
DECLARE
  entry journal_entries%ROWTYPE;
  target accounts%ROWTYPE;
BEGIN
  SELECT * INTO entry FROM journal_entries WHERE id = NEW.entry_id;
  IF FOUND THEN
    IF entry.created_at <> now() THEN
      RAISE EXCEPTION 'journal_lines: lines are only added in the transaction that created entry %', NEW.entry_id
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM accounting_assert_period_open(entry.entry_date);
  END IF;
  SELECT * INTO target FROM accounts WHERE code = NEW.account_code FOR SHARE;
  IF FOUND AND (target.is_header OR NOT target.is_active) THEN
    RAISE EXCEPTION 'journal_lines: account % is a header or inactive and cannot be posted to', NEW.account_code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_postable_account', TABLE = 'journal_lines';
  END IF;
  IF NEW.cash_account_code IS NOT NULL THEN
    SELECT * INTO target FROM accounts WHERE code = NEW.cash_account_code FOR SHARE;
    IF FOUND AND (target.is_header OR NOT target.is_active) THEN
      RAISE EXCEPTION 'journal_lines: cash account % is a header or inactive', NEW.cash_account_code
        USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_postable_account', TABLE = 'journal_lines';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER journal_lines_guard_insert BEFORE INSERT ON "journal_lines" FOR EACH ROW
  EXECUTE FUNCTION journal_lines_guard_insert();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION journal_lines_guard_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'journal_lines is append-only; lines are never changed or deleted (reverse the entry instead)'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER journal_lines_guard_mutation BEFORE UPDATE OR DELETE ON "journal_lines" FOR EACH ROW
  EXECUTE FUNCTION journal_lines_guard_mutation();
--> statement-breakpoint

-- D-14 guard (plan §3 "raw-material purchases are inventory, never expense", §4.8): a purchase-side
-- journal (goods receipt, supplier payment, purchase, production batch posting, defect returned to
-- the supplier/tailor) never touches an expense, HPP, other-expense or tax account. The list
-- mirrors PURCHASE_SIDE_JOURNAL_SOURCES / EXPENSE_LIKE_ACCOUNT_TYPES in
-- packages/db/src/schema/constants.ts (migration-0049.test.ts checks each pair). Reversals carry
-- their source key too, so they are held to the same rule.
CREATE OR REPLACE FUNCTION journal_line_purchase_guard()
RETURNS trigger AS $$
DECLARE
  entry_source text;
  entry_event text;
  account_type text;
BEGIN
  SELECT source_type, source_event INTO entry_source, entry_event FROM journal_entries WHERE id = NEW.entry_id;
  IF entry_source IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT (entry_source IN ('goods_receipt_item', 'supplier_payment', 'purchase')
          OR (entry_source = 'production_batch' AND entry_event = 'posted')
          OR (entry_source = 'defect_movement' AND entry_event = 'return_out')) THEN
    RETURN NEW;
  END IF;
  SELECT type INTO account_type FROM accounts WHERE code = NEW.account_code;
  IF account_type IN ('cogs', 'expense', 'other_expense', 'tax') THEN
    RAISE EXCEPTION 'journal_lines: a % journal (%) can never post to % account %; raw-material purchases and supplier payments are inventory, utang or advances (D-14)',
      entry_source, entry_event, account_type, NEW.account_code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_purchase_guard', TABLE = 'journal_lines';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER journal_line_purchase_guard BEFORE INSERT ON "journal_lines" FOR EACH ROW
  EXECUTE FUNCTION journal_line_purchase_guard();
--> statement-breakpoint

-- Every entry balances (Σ debit = Σ credit) with at least two lines; a reversal's target names it
-- in reversed_by_entry_id, and the reversal mirrors the target exactly (the same account, amount
-- and dimensions per line with debit and credit swapped), so stamping an unrelated entry as "the
-- reversal" cannot free a posting key. Deferred to commit, so an entry and its lines (and the stamp) are
-- written first and checked together. Fires per entry and per line; the volume is small.
CREATE OR REPLACE FUNCTION journal_entry_assert_balanced()
RETURNS trigger AS $$
DECLARE
  target_id uuid;
  line_count integer;
  debit_total bigint;
  credit_total bigint;
  entry_kind text;
  reversed_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    target_id := NEW.id;
  ELSE
    target_id := NEW.entry_id;
  END IF;
  SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    INTO line_count, debit_total, credit_total
    FROM journal_lines WHERE entry_id = target_id;
  IF line_count < 2 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'journal entry % does not balance (% lines, debit %, credit %)', target_id, line_count, debit_total, credit_total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entries_balanced', TABLE = 'journal_entries';
  END IF;
  SELECT kind, reverses_entry_id INTO entry_kind, reversed_id FROM journal_entries WHERE id = target_id;
  IF entry_kind = 'reversal' AND NOT EXISTS (
    SELECT 1 FROM journal_entries WHERE id = reversed_id AND reversed_by_entry_id = target_id
  ) THEN
    RAISE EXCEPTION 'journal entry %: the reversed entry % must be stamped with reversed_by_entry_id', target_id, reversed_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entries_reversal_stamped', TABLE = 'journal_entries';
  END IF;
  IF entry_kind = 'reversal' AND EXISTS (
    (SELECT account_code, credit, debit, channel_id, supplier_id, order_id, cash_account_code
       FROM journal_lines WHERE entry_id = reversed_id
     EXCEPT ALL
     SELECT account_code, debit, credit, channel_id, supplier_id, order_id, cash_account_code
       FROM journal_lines WHERE entry_id = target_id)
    UNION ALL
    (SELECT account_code, debit, credit, channel_id, supplier_id, order_id, cash_account_code
       FROM journal_lines WHERE entry_id = target_id
     EXCEPT ALL
     SELECT account_code, credit, debit, channel_id, supplier_id, order_id, cash_account_code
       FROM journal_lines WHERE entry_id = reversed_id)
  ) THEN
    RAISE EXCEPTION 'journal entry %: a reversal must mirror entry % line for line (same accounts, amounts and dimensions, sides swapped)', target_id, reversed_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entries_reversal_mirrors', TABLE = 'journal_entries';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER journal_entry_balanced AFTER INSERT ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION journal_entry_assert_balanced();
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER journal_line_balanced AFTER INSERT ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION journal_entry_assert_balanced();
