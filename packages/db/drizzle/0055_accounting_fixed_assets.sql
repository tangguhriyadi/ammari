CREATE TABLE "fixed_asset_groups" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"useful_life_months" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_by_staff_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_asset_groups_code_check" CHECK ("fixed_asset_groups"."code" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "fixed_asset_groups_label_check" CHECK (btrim("fixed_asset_groups"."label") <> '' and char_length("fixed_asset_groups"."label") <= 60),
	CONSTRAINT "fixed_asset_groups_life_check" CHECK ("fixed_asset_groups"."useful_life_months" between 1 and 600)
);
--> statement-breakpoint
CREATE TABLE "fixed_asset_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"capitalization_threshold" bigint NOT NULL,
	"updated_by_staff_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_asset_settings_singleton_check" CHECK ("fixed_asset_settings"."id" = 1),
	CONSTRAINT "fixed_asset_settings_threshold_check" CHECK ("fixed_asset_settings"."capitalization_threshold" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"group_code" text NOT NULL,
	"useful_life_months" integer NOT NULL,
	"acquisition_date" date NOT NULL,
	"cost" bigint NOT NULL,
	"asset_account_code" text NOT NULL,
	"accumulated_account_code" text NOT NULL,
	"funding_account_code" text,
	"disposed_on" date,
	"disposal_proceeds" bigint,
	"disposal_cash_account_code" text,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"note" text,
	"created_by_staff_user_id" uuid NOT NULL,
	"updated_by_staff_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_assets_name_check" CHECK (btrim("fixed_assets"."name") <> '' and char_length("fixed_assets"."name") <= 120),
	CONSTRAINT "fixed_assets_life_check" CHECK ("fixed_assets"."useful_life_months" between 1 and 600),
	CONSTRAINT "fixed_assets_cost_check" CHECK ("fixed_assets"."cost" > 0),
	CONSTRAINT "fixed_assets_asset_account_check" CHECK ("fixed_assets"."asset_account_code" ~ '^1-2[0-9]{3}$'),
	CONSTRAINT "fixed_assets_accumulated_account_check" CHECK ("fixed_assets"."accumulated_account_code" ~ '^1-2[0-9]{3}$' and "fixed_assets"."accumulated_account_code" <> "fixed_assets"."asset_account_code"),
	CONSTRAINT "fixed_assets_funding_account_check" CHECK ("fixed_assets"."funding_account_code" is null or "fixed_assets"."funding_account_code" ~ '^(1-1[12][0-9]{2}|2-[0-9]{4})$'),
	CONSTRAINT "fixed_assets_disposal_check" CHECK (("fixed_assets"."disposed_on" is null and "fixed_assets"."disposal_proceeds" is null and "fixed_assets"."disposal_cash_account_code" is null)
        or ("fixed_assets"."disposed_on" is not null and "fixed_assets"."disposed_on" >= "fixed_assets"."acquisition_date"
            and "fixed_assets"."disposal_proceeds" is not null and "fixed_assets"."disposal_proceeds" >= 0
            and ("fixed_assets"."disposal_proceeds" = 0) = ("fixed_assets"."disposal_cash_account_code" is null)
            and ("fixed_assets"."disposal_cash_account_code" is null or "fixed_assets"."disposal_cash_account_code" ~ '^1-1[12][0-9]{2}$'))),
	CONSTRAINT "fixed_assets_void_check" CHECK (("fixed_assets"."voided_at" is null and "fixed_assets"."void_reason" is null)
        or ("fixed_assets"."voided_at" is not null and "fixed_assets"."void_reason" is not null and btrim("fixed_assets"."void_reason") <> '' and char_length("fixed_assets"."void_reason") <= 500)),
	CONSTRAINT "fixed_assets_note_check" CHECK ("fixed_assets"."note" is null or (btrim("fixed_assets"."note") <> '' and char_length("fixed_assets"."note") <= 500))
);
--> statement-breakpoint
ALTER TABLE "fixed_asset_groups" ADD CONSTRAINT "fixed_asset_groups_updated_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("updated_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_settings" ADD CONSTRAINT "fixed_asset_settings_updated_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("updated_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_group_code_fixed_asset_groups_code_fk" FOREIGN KEY ("group_code") REFERENCES "public"."fixed_asset_groups"("code") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_asset_account_code_accounts_code_fk" FOREIGN KEY ("asset_account_code") REFERENCES "public"."accounts"("code") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_accumulated_account_code_accounts_code_fk" FOREIGN KEY ("accumulated_account_code") REFERENCES "public"."accounts"("code") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_funding_account_code_accounts_code_fk" FOREIGN KEY ("funding_account_code") REFERENCES "public"."accounts"("code") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_cash_account_code_accounts_code_fk" FOREIGN KEY ("disposal_cash_account_code") REFERENCES "public"."accounts"("code") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_created_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_updated_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("updated_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fixed_asset_groups_updated_by_staff_user_id_idx" ON "fixed_asset_groups" USING btree ("updated_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "fixed_asset_settings_updated_by_staff_user_id_idx" ON "fixed_asset_settings" USING btree ("updated_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "fixed_assets_group_code_idx" ON "fixed_assets" USING btree ("group_code");--> statement-breakpoint
CREATE INDEX "fixed_assets_asset_account_code_idx" ON "fixed_assets" USING btree ("asset_account_code");--> statement-breakpoint
CREATE INDEX "fixed_assets_accumulated_account_code_idx" ON "fixed_assets" USING btree ("accumulated_account_code");--> statement-breakpoint
CREATE INDEX "fixed_assets_funding_account_code_idx" ON "fixed_assets" USING btree ("funding_account_code");--> statement-breakpoint
CREATE INDEX "fixed_assets_disposal_cash_account_code_idx" ON "fixed_assets" USING btree ("disposal_cash_account_code");--> statement-breakpoint
CREATE INDEX "fixed_assets_created_by_staff_user_id_idx" ON "fixed_assets" USING btree ("created_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "fixed_assets_updated_by_staff_user_id_idx" ON "fixed_assets" USING btree ("updated_by_staff_user_id");--> statement-breakpoint

-- ---- Hand-authored (Session 11, docs/plans/accounting.md §5.3, D-19) -----------------------------
-- Additive only: three new tables, their stamps and guards, and the reference rows the register and
-- the posting rule read (CLAUDE.md: reference data ships in the migration, ON CONFLICT DO NOTHING).
-- Nothing existing is altered, so the previous release runs unchanged against this schema.

CREATE TRIGGER set_updated_at BEFORE UPDATE ON "fixed_asset_groups" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "fixed_asset_settings" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "fixed_assets" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint

-- The register and its settings are never deleted (a wrong asset is voided; the journals derived
-- from it are reversed by the posting runner, and the row keeps the history).
CREATE TRIGGER prevent_fixed_asset_group_delete BEFORE DELETE ON "fixed_asset_groups" FOR EACH ROW
  EXECUTE FUNCTION prevent_accounting_delete();
--> statement-breakpoint
CREATE TRIGGER prevent_fixed_asset_settings_delete BEFORE DELETE ON "fixed_asset_settings" FOR EACH ROW
  EXECUTE FUNCTION prevent_accounting_delete();
--> statement-breakpoint
CREATE TRIGGER prevent_fixed_asset_delete BEFORE DELETE ON "fixed_assets" FOR EACH ROW
  EXECUTE FUNCTION prevent_accounting_delete();
--> statement-breakpoint

-- A group's code never changes (assets point at it); a voided asset is final (no edit, no un-void).
CREATE OR REPLACE FUNCTION fixed_asset_groups_guard_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'fixed_asset_groups %: code is immutable', OLD.code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER fixed_asset_groups_guard_update BEFORE UPDATE ON "fixed_asset_groups" FOR EACH ROW
  EXECUTE FUNCTION fixed_asset_groups_guard_update();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION fixed_assets_guard_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_by_staff_user_id IS DISTINCT FROM OLD.created_by_staff_user_id THEN
    RAISE EXCEPTION 'fixed_assets %: id and created_by are immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'fixed_assets %: a voided asset is never changed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER fixed_assets_guard_update BEFORE UPDATE ON "fixed_assets" FOR EACH ROW
  EXECUTE FUNCTION fixed_assets_guard_update();
--> statement-breakpoint

-- D-19 settings (FIXED_ASSET_GROUPS, INITIAL_CAPITALIZATION_THRESHOLD in
-- packages/db/src/accounting/chart-of-accounts.ts; migration-0055.test.ts pins them).
INSERT INTO "fixed_asset_groups" ("code", "label", "useful_life_months", "sort_order") VALUES
  ('group_1', 'Kelompok 1', 48, 10),
  ('group_2', 'Kelompok 2', 96, 20)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "fixed_asset_settings" ("id", "capitalization_threshold") VALUES (1, 1000000)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- The gain or loss of a disposal (plan §5.3, Dr/Cr 8-1102), only while 8-1102 still exists, is
-- active and postable (account_mappings_guard_target would refuse it otherwise; an accountant who
-- removed it maps the key herself, and the rule raises an issue until then).
INSERT INTO "account_mappings" ("mapping_key", "account_code")
SELECT 'fixed_asset.disposal_result', '8-1102'
WHERE EXISTS (SELECT 1 FROM "accounts" WHERE "code" = '8-1102' AND "is_active" AND NOT "is_header")
ON CONFLICT DO NOTHING;
