-- Migration 0048: Kategori Biaya master data (docs/plans/expense-master-data.md §3.1-§3.4, session S1).
-- Expense categories become an owner-managed table with cost items per category, and an expense
-- may name its item. EXPAND-ONLY: the release before this one keeps working unchanged against this
-- schema (it writes one of the ten seeded codes and never names item_id). The statement order is
-- deliberate (drizzle-kit's statements, re-ordered by hand): tables, reference rows, the
-- replacement rules, and only then are the three CHECKs over the fixed code list dropped and the
-- FKs added, so no rule is ever unenforced.

CREATE TABLE "expense_categories" (
	"code" text PRIMARY KEY NOT NULL,
	"name" "citext" NOT NULL,
	"kind" text NOT NULL,
	"fixed_channel_id" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_categories_name_unique" UNIQUE("name"),
	CONSTRAINT "expense_categories_code_check" CHECK ("expense_categories"."code" ~ '^[a-z][a-z0-9_]{0,39}$' and "expense_categories"."code" <> 'biaya_produksi'),
	CONSTRAINT "expense_categories_name_check" CHECK (btrim("expense_categories"."name"::text) <> '' and char_length("expense_categories"."name"::text) <= 60 and regexp_replace(lower(btrim("expense_categories"."name"::text)), '\s+', ' ', 'g') <> 'biaya produksi'),
	CONSTRAINT "expense_categories_kind_check" CHECK ("expense_categories"."kind" in ('ad', 'endorsement', 'operating')),
	CONSTRAINT "expense_categories_fixed_channel_check" CHECK ("expense_categories"."fixed_channel_id" is null or ("expense_categories"."kind" = 'ad' and "expense_categories"."is_system")),
	CONSTRAINT "expense_categories_system_active_check" CHECK ("expense_categories"."is_active" or not "expense_categories"."is_system")
);--> statement-breakpoint

ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_fixed_channel_id_channels_id_fk" FOREIGN KEY ("fixed_channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "expense_categories_fixed_channel_id_idx" ON "expense_categories" USING btree ("fixed_channel_id");--> statement-breakpoint

CREATE TABLE "expense_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_code" text NOT NULL,
	"name" "citext" NOT NULL,
	"note" text,
	"default_amount" bigint,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_items_category_code_name_key" UNIQUE("category_code","name"),
	CONSTRAINT "expense_items_id_category_code_key" UNIQUE("id","category_code"),
	CONSTRAINT "expense_items_name_check" CHECK (btrim("expense_items"."name"::text) <> '' and char_length("expense_items"."name"::text) <= 80),
	CONSTRAINT "expense_items_note_check" CHECK ("expense_items"."note" is null or (btrim("expense_items"."note") <> '' and char_length("expense_items"."note") <= 200)),
	CONSTRAINT "expense_items_default_amount_check" CHECK ("expense_items"."default_amount" is null or ("expense_items"."default_amount" > 0 and "expense_items"."default_amount" <= 1000000000))
);--> statement-breakpoint

ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_category_code_expense_categories_code_fk" FOREIGN KEY ("category_code") REFERENCES "public"."expense_categories"("code") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint

-- Hand-authored: the ten pre-0048 categories, codes and labels unchanged (DEFAULT_EXPENSE_CATEGORIES
-- in packages/db/src/schema/constants.ts; migration-0048.test.ts asserts they agree). Reference data
-- the code matches by literal (CLAUDE.md DB rule), so it ships here; seed.ts repeats it insert-only
-- for truncated test databases. ON CONFLICT DO NOTHING never overwrites a later rename or re-order.
INSERT INTO "expense_categories" ("code", "name", "kind", "fixed_channel_id", "is_system", "sort_order") VALUES
  ('ads_meta', 'Iklan Meta', 'ad', NULL, true, 10),
  ('ads_tiktok', 'Iklan TikTok', 'ad', 'tiktok', true, 20),
  ('ads_shopee', 'Iklan Shopee', 'ad', 'shopee', true, 30),
  ('endorsement', 'Endorse/KOL', 'endorsement', NULL, true, 40),
  ('material_shipping', 'Ongkir bahan', 'operating', NULL, false, 110),
  ('packaging', 'Packaging', 'operating', NULL, false, 120),
  ('salary', 'Gaji', 'operating', NULL, false, 130),
  ('rent', 'Sewa', 'operating', NULL, false, 140),
  ('utilities', 'Utilitas', 'operating', NULL, false, 150),
  ('other', 'Lainnya', 'operating', NULL, true, 990)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

-- Hand-authored: drizzle-kit does not emit triggers (same idiom as 0037).
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "expense_categories" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "expense_items" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint

-- A category's identity never changes: its code (what expenses store), its kind (changing it would
-- move historical spend in or out of ROAS), its fixed channel and its system flag. Name, order and
-- (for non-system categories) is_active stay editable.
CREATE OR REPLACE FUNCTION prevent_expense_category_identity_change()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'expense_categories %: code, kind, fixed_channel_id and is_system are immutable', OLD.code
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_expense_category_identity_change BEFORE UPDATE ON "expense_categories" FOR EACH ROW
  WHEN (NEW.code IS DISTINCT FROM OLD.code OR NEW.kind IS DISTINCT FROM OLD.kind
        OR NEW.fixed_channel_id IS DISTINCT FROM OLD.fixed_channel_id OR NEW.is_system IS DISTINCT FROM OLD.is_system)
  EXECUTE FUNCTION prevent_expense_category_identity_change();
--> statement-breakpoint

-- An item never moves to another category (business_expenses_item_category_fk pins an expense's
-- item to the expense's category; this also covers items nothing uses yet).
CREATE OR REPLACE FUNCTION prevent_expense_item_category_change()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'expense_items %: category_code is immutable', OLD.id
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_expense_item_category_change BEFORE UPDATE ON "expense_items" FOR EACH ROW
  WHEN (NEW.category_code IS DISTINCT FROM OLD.category_code)
  EXECUTE FUNCTION prevent_expense_item_category_change();
--> statement-breakpoint

-- No hard delete, ever (plan §3.6; "delete" in the admin is is_active = false). Also guards the
-- seeded rows the previous release inserts expenses against.
CREATE OR REPLACE FUNCTION prevent_expense_master_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted; deactivate instead', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_expense_category_delete BEFORE DELETE ON "expense_categories" FOR EACH ROW
  EXECUTE FUNCTION prevent_expense_master_delete();
--> statement-breakpoint

CREATE TRIGGER prevent_expense_item_delete BEFORE DELETE ON "expense_items" FOR EACH ROW
  EXECUTE FUNCTION prevent_expense_master_delete();
--> statement-breakpoint

-- Replaces business_expenses_channel_check (0042), whose CASE named the fixed codes and refused a
-- channel on every other category: the same rule, read from the category row. A fixed channel must
-- be named exactly; ad/endorsement may name one or none; operating names none. For the ten seeded
-- codes the verdicts are exactly the dropped CHECK's. INSERT only: business_expenses is append-only
-- (prevent_voidable_record_mutation refuses every UPDATE but the void stamp), and a category's
-- kind/fixed channel never change. An unknown category is left to the category FK. The error keeps
-- the old constraint name, so anything matching on it still does.
CREATE OR REPLACE FUNCTION business_expense_channel_rule()
RETURNS trigger AS $$
DECLARE
  category_kind text;
  category_channel text;
BEGIN
  SELECT kind, fixed_channel_id INTO category_kind, category_channel
  FROM expense_categories WHERE code = NEW.category;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF (category_channel IS NOT NULL AND NEW.channel_id IS DISTINCT FROM category_channel)
     OR (category_kind = 'operating' AND NEW.channel_id IS NOT NULL) THEN
    RAISE EXCEPTION 'new row for relation "business_expenses" violates check constraint "business_expenses_channel_check" (category %, channel %)',
      NEW.category, coalesce(NEW.channel_id, 'none')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'business_expenses_channel_check', TABLE = 'business_expenses';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER business_expense_channel_rule BEFORE INSERT ON "business_expenses" FOR EACH ROW
  EXECUTE FUNCTION business_expense_channel_rule();
--> statement-breakpoint

-- Replaces sales_goal_monthly_bill_categories_allowed_check (0043): every chosen category must
-- exist (any category may be a monthly bill, owner answer D3). An array element cannot carry an
-- FK; categories are never deleted, so checking on write is enough. The no-duplicates CHECK stays.
CREATE OR REPLACE FUNCTION sales_goal_monthly_bill_categories_known()
RETURNS trigger AS $$
DECLARE
  unknown text;
BEGIN
  SELECT element INTO unknown
  FROM unnest(NEW.monthly_bill_categories) AS element
  WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE code = element)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'new row for relation "sales_goal" violates check constraint "sales_goal_monthly_bill_categories_known" (unknown category %)', unknown
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_goal_monthly_bill_categories_known', TABLE = 'sales_goal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER sales_goal_monthly_bill_categories_known BEFORE INSERT OR UPDATE OF "monthly_bill_categories" ON "sales_goal" FOR EACH ROW
  EXECUTE FUNCTION sales_goal_monthly_bill_categories_known();
--> statement-breakpoint

-- The CHECKs over the fixed code list can go now: each one's rule is enforced above.
ALTER TABLE "sales_goal" DROP CONSTRAINT "sales_goal_monthly_bill_categories_allowed_check";--> statement-breakpoint
ALTER TABLE "business_expenses" DROP CONSTRAINT "business_expenses_channel_check";--> statement-breakpoint

-- Validated in place: every existing row holds one of the ten seeded codes (the CHECK dropped next
-- guaranteed it), and the table is small.
ALTER TABLE "business_expenses" ADD CONSTRAINT "business_expenses_category_expense_categories_code_fk" FOREIGN KEY ("category") REFERENCES "public"."expense_categories"("code") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "business_expenses" DROP CONSTRAINT "business_expenses_category_check";--> statement-breakpoint

-- Nullable, no default: catalog-only. Append-only rows are never backfilled (MATCH SIMPLE FK: a
-- NULL item_id is not checked).
ALTER TABLE "business_expenses" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "business_expenses" ADD CONSTRAINT "business_expenses_item_category_fk" FOREIGN KEY ("item_id","category") REFERENCES "public"."expense_items"("id","category_code") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "business_expenses_item_id_idx" ON "business_expenses" USING btree ("item_id");
