-- Hand-authored comment (docs/plans/growth.md §6, owner answer A6, 2026-10-27): the "Pengingat biaya
-- bulanan" categories live on the one sales_goal row (same /settings page, same settings.manage +
-- finance.view_profit gate). Additive and backward-compatible: the default '{}' (reminder off)
-- fills the existing row, and the previous release never reads the column, so a rollback image
-- keeps working against this schema. No reference row: migration 0039 already inserts row 1.
ALTER TABLE "sales_goal" ADD COLUMN "monthly_bill_categories" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_goal" ADD CONSTRAINT "sales_goal_monthly_bill_categories_allowed_check" CHECK ("sales_goal"."monthly_bill_categories" <@ ARRAY['ads_meta', 'ads_tiktok', 'ads_shopee', 'endorsement', 'material_shipping', 'packaging', 'salary', 'rent', 'utilities', 'other']::text[]);--> statement-breakpoint
ALTER TABLE "sales_goal" ADD CONSTRAINT "sales_goal_monthly_bill_categories_no_duplicates_check" CHECK (not text_array_has_duplicates("sales_goal"."monthly_bill_categories"));
