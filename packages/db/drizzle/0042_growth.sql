CREATE TABLE "voucher_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voucher_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"previous_status" text NOT NULL,
	"previous_expires_at" timestamp with time zone NOT NULL,
	"new_expires_at" timestamp with time zone,
	"reason" text NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_adjustments_kind_check" CHECK ("voucher_adjustments"."kind" in ('void', 'extend')),
	CONSTRAINT "voucher_adjustments_previous_status_check" CHECK ("voucher_adjustments"."previous_status" in ('active', 'used', 'expired', 'void')),
	CONSTRAINT "voucher_adjustments_new_expires_at_check" CHECK (("voucher_adjustments"."kind" = 'extend') = ("voucher_adjustments"."new_expires_at" is not null) and ("voucher_adjustments"."new_expires_at" is null or "voucher_adjustments"."new_expires_at" > "voucher_adjustments"."previous_expires_at")),
	CONSTRAINT "voucher_adjustments_reason_check" CHECK (btrim("voucher_adjustments"."reason") <> '' and char_length("voucher_adjustments"."reason") <= 500)
);
--> statement-breakpoint
CREATE TABLE "business_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_no" text NOT NULL,
	"expense_date" date NOT NULL,
	"category" text NOT NULL,
	"amount" bigint NOT NULL,
	"method" text NOT NULL,
	"channel_id" text,
	"campaign" text,
	"note" text,
	"proof_file_id" uuid NOT NULL,
	"proof_file_purpose" text DEFAULT 'expense_proof' NOT NULL,
	"recorded_by_staff_user_id" uuid NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by_staff_user_id" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_expenses_expense_no_unique" UNIQUE("expense_no"),
	CONSTRAINT "business_expenses_proof_file_id_unique" UNIQUE("proof_file_id"),
	CONSTRAINT "business_expenses_category_check" CHECK ("business_expenses"."category" in ('ads_meta', 'ads_tiktok', 'ads_shopee', 'endorsement', 'material_shipping', 'packaging', 'salary', 'rent', 'utilities', 'other')),
	CONSTRAINT "business_expenses_method_check" CHECK ("business_expenses"."method" in ('cash', 'transfer', 'card', 'platform_balance')),
	CONSTRAINT "business_expenses_amount_check" CHECK ("business_expenses"."amount" > 0),
	CONSTRAINT "business_expenses_channel_check" CHECK (case when category = 'ads_shopee' then channel_id is not distinct from 'shopee' when category = 'ads_tiktok' then channel_id is not distinct from 'tiktok' when "business_expenses"."category" in ('ads_meta', 'ads_tiktok', 'ads_shopee', 'endorsement') then true else "business_expenses"."channel_id" is null end),
	CONSTRAINT "business_expenses_campaign_check" CHECK ("business_expenses"."campaign" is null or (btrim("business_expenses"."campaign") <> '' and char_length("business_expenses"."campaign") <= 120)),
	CONSTRAINT "business_expenses_note_check" CHECK ("business_expenses"."note" is null or (btrim("business_expenses"."note") <> '' and char_length("business_expenses"."note") <= 500)),
	CONSTRAINT "business_expenses_other_note_check" CHECK ("business_expenses"."category" <> 'other' or "business_expenses"."note" is not null),
	CONSTRAINT "business_expenses_proof_file_purpose_check" CHECK ("business_expenses"."proof_file_purpose" = 'expense_proof'),
	CONSTRAINT "business_expenses_voided_triple_check" CHECK (num_nonnulls("business_expenses"."voided_at", "business_expenses"."voided_by_staff_user_id", "business_expenses"."void_reason") in (0, 3) and ("business_expenses"."void_reason" is null or btrim("business_expenses"."void_reason") <> ''))
);
--> statement-breakpoint
-- Hand-moved up from the end (drizzle-kit emits the ADD last): the CHECK widen stays one visible
-- drop + add pair. A widen only (docs/plans/growth.md §3.3): every existing row passes, and the
-- previous release never writes 'expense_proof'. Runs in the migration's transaction, so no
-- moment exists without the CHECK.
ALTER TABLE "private_files" DROP CONSTRAINT "private_files_purpose_check";--> statement-breakpoint
ALTER TABLE "private_files" ADD CONSTRAINT "private_files_purpose_check" CHECK ("private_files"."purpose" in ('payment_proof', 'purchase_invoice', 'expense_proof'));--> statement-breakpoint
ALTER TABLE "voucher_adjustments" ADD CONSTRAINT "voucher_adjustments_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_adjustments" ADD CONSTRAINT "voucher_adjustments_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_expenses" ADD CONSTRAINT "business_expenses_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_expenses" ADD CONSTRAINT "business_expenses_recorded_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("recorded_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_expenses" ADD CONSTRAINT "business_expenses_voided_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("voided_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_expenses" ADD CONSTRAINT "business_expenses_proof_file_fk" FOREIGN KEY ("proof_file_id","proof_file_purpose") REFERENCES "public"."private_files"("id","purpose") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "voucher_adjustments_voucher_id_created_at_idx" ON "voucher_adjustments" USING btree ("voucher_id","created_at");--> statement-breakpoint
CREATE INDEX "voucher_adjustments_staff_user_id_idx" ON "voucher_adjustments" USING btree ("staff_user_id");--> statement-breakpoint
CREATE INDEX "business_expenses_expense_date_created_at_idx" ON "business_expenses" USING btree ("expense_date","created_at");--> statement-breakpoint
CREATE INDEX "business_expenses_category_expense_date_idx" ON "business_expenses" USING btree ("category","expense_date");--> statement-breakpoint
CREATE INDEX "business_expenses_channel_id_idx" ON "business_expenses" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "business_expenses_recorded_by_staff_user_id_idx" ON "business_expenses" USING btree ("recorded_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "business_expenses_voided_by_staff_user_id_idx" ON "business_expenses" USING btree ("voided_by_staff_user_id");--> statement-breakpoint

-- Hand-authored below this line (same idiom as migrations 0038/0041): drizzle-kit does not emit
-- triggers or reference data. docs/plans/growth.md §3, §9.3, §11.
--
-- business_expenses is append-only except for voiding (plan G3), exactly like supplier_payments:
-- reuse migration 0038's prevent_voidable_record_mutation (DELETE refused; UPDATE refused unless
-- only the three void columns change, from NULL, once). The triple CHECK makes the void
-- all-three-or-none with a non-blank reason.
DROP TRIGGER IF EXISTS prevent_business_expense_mutation ON "business_expenses";--> statement-breakpoint

CREATE TRIGGER prevent_business_expense_mutation BEFORE UPDATE OR DELETE ON "business_expenses" FOR EACH ROW
  EXECUTE FUNCTION prevent_voidable_record_mutation();
--> statement-breakpoint

-- voucher_adjustments is a history: never updated, never deleted. TRUNCATE is deliberately not
-- blocked, same as every other append-only table here (disposable test databases reset with it).
CREATE OR REPLACE FUNCTION prevent_voucher_adjustment_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'voucher_adjustments is append-only; rows are never updated or deleted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS prevent_voucher_adjustment_mutation ON "voucher_adjustments";--> statement-breakpoint

CREATE TRIGGER prevent_voucher_adjustment_mutation BEFORE UPDATE OR DELETE ON "voucher_adjustments" FOR EACH ROW
  EXECUTE FUNCTION prevent_voucher_adjustment_mutation();
--> statement-breakpoint

-- New permission keys (reference data the code matches by literal key, so they ship here, not
-- only in seed.ts; CLAUDE.md). Idempotent throughout (ON CONFLICT DO NOTHING).
-- - customers.manage (owner answer Q7): record a promo-consent withdrawal. super_admin, owner,
--   and the predefined CS role (below).
-- - customers.export (owner answer Q9): the promo contact export. super_admin and owner only.
INSERT INTO "permissions" ("key", "description", "group") VALUES
  ('customers.manage', 'Record a customer''s promo-consent withdrawal', 'customers'),
  ('customers.export', 'Export promo-consenting customer contacts', 'customers')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r, "permissions" p
WHERE r."key" IN ('super_admin', 'owner') AND p."key" IN ('customers.manage', 'customers.export')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;--> statement-breakpoint

-- The predefined CS role (migration 0041) gets customers.manage, but only while it still holds
-- customers.view: that is the role as shipped. If a super_admin has since taken customer access
-- away from CS, this leaves the role exactly as they made it.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "role_permissions" rp ON rp."role_id" = r."id"
JOIN "permissions" viewp ON viewp."id" = rp."permission_id" AND viewp."key" = 'customers.view'
CROSS JOIN "permissions" p
WHERE r."key" = 'customer_service' AND p."key" = 'customers.manage'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;--> statement-breakpoint

-- Descriptions only, no grant changes: vouchers.void now also covers extending (owner answer Q8),
-- and ads_expenses.manage now covers voiding and viewing proofs (plan §7). Matches
-- packages/db/src/rbac/permissions.ts.
UPDATE "permissions" SET "description" = 'Void or extend a voucher' WHERE "key" = 'vouchers.void';--> statement-breakpoint
UPDATE "permissions" SET "description" = 'Record and void ad and operating expenses, and view their proofs' WHERE "key" = 'ads_expenses.manage';
