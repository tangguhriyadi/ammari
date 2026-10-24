CREATE TABLE "private_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"original_filename" text NOT NULL,
	"original_content_type" text NOT NULL,
	"original_byte_size" integer NOT NULL,
	"original_sha256" text NOT NULL,
	"uploaded_by_staff_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_files_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "private_files_id_purpose_key" UNIQUE("id","purpose"),
	CONSTRAINT "private_files_purpose_check" CHECK ("private_files"."purpose" in ('payment_proof', 'purchase_invoice')),
	CONSTRAINT "private_files_content_type_check" CHECK ("private_files"."content_type" in ('image/jpeg', 'application/pdf')),
	CONSTRAINT "private_files_storage_key_check" CHECK (btrim("private_files"."storage_key") <> ''),
	CONSTRAINT "private_files_byte_size_check" CHECK ("private_files"."byte_size" > 0),
	CONSTRAINT "private_files_original_byte_size_check" CHECK ("private_files"."original_byte_size" > 0),
	CONSTRAINT "private_files_sha256_check" CHECK ("private_files"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "private_files_original_sha256_check" CHECK ("private_files"."original_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "private_files_original_filename_check" CHECK (btrim("private_files"."original_filename") <> '' and char_length("private_files"."original_filename") <= 255)
);
--> statement-breakpoint
CREATE TABLE "purchase_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_id" uuid NOT NULL,
	"file_purpose" text DEFAULT 'purchase_invoice' NOT NULL,
	"note" text,
	"created_by_staff_user_id" uuid NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by_staff_user_id" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_attachments_file_id_unique" UNIQUE("file_id"),
	CONSTRAINT "purchase_attachments_kind_check" CHECK ("purchase_attachments"."kind" in ('invoice')),
	CONSTRAINT "purchase_attachments_file_purpose_check" CHECK ("purchase_attachments"."file_purpose" = 'purchase_invoice'),
	CONSTRAINT "purchase_attachments_voided_triple_check" CHECK (num_nonnulls("purchase_attachments"."voided_at", "purchase_attachments"."voided_by_staff_user_id", "purchase_attachments"."void_reason") in (0, 3) and ("purchase_attachments"."void_reason" is null or btrim("purchase_attachments"."void_reason") <> ''))
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_no" text NOT NULL,
	"target_type" text NOT NULL,
	"purchase_id" uuid,
	"production_batch_id" uuid,
	"supplier_id" uuid,
	"supplier_name" text,
	"paid_at" date NOT NULL,
	"amount" bigint NOT NULL,
	"method" text NOT NULL,
	"note" text,
	"proof_file_id" uuid NOT NULL,
	"proof_file_purpose" text DEFAULT 'payment_proof' NOT NULL,
	"recorded_by_staff_user_id" uuid NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by_staff_user_id" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_payments_payment_no_unique" UNIQUE("payment_no"),
	CONSTRAINT "supplier_payments_proof_file_id_unique" UNIQUE("proof_file_id"),
	CONSTRAINT "supplier_payments_target_type_check" CHECK ("supplier_payments"."target_type" in ('purchase', 'production_batch')),
	CONSTRAINT "supplier_payments_exactly_one_target_check" CHECK (("supplier_payments"."purchase_id" is null) <> ("supplier_payments"."production_batch_id" is null) and ("supplier_payments"."target_type" = 'purchase') = ("supplier_payments"."purchase_id" is not null)),
	CONSTRAINT "supplier_payments_purchase_payee_check" CHECK ("supplier_payments"."target_type" <> 'purchase' or "supplier_payments"."supplier_id" is not null),
	CONSTRAINT "supplier_payments_supplier_pair_check" CHECK (("supplier_payments"."supplier_id" is null) = ("supplier_payments"."supplier_name" is null)),
	CONSTRAINT "supplier_payments_amount_check" CHECK ("supplier_payments"."amount" > 0),
	CONSTRAINT "supplier_payments_method_check" CHECK ("supplier_payments"."method" in ('cash', 'transfer')),
	CONSTRAINT "supplier_payments_proof_file_purpose_check" CHECK ("supplier_payments"."proof_file_purpose" = 'payment_proof'),
	CONSTRAINT "supplier_payments_voided_triple_check" CHECK (num_nonnulls("supplier_payments"."voided_at", "supplier_payments"."voided_by_staff_user_id", "supplier_payments"."void_reason") in (0, 3) and ("supplier_payments"."void_reason" is null or btrim("supplier_payments"."void_reason") <> ''))
);
--> statement-breakpoint
-- Hand-moved above the foreign keys (drizzle-kit emits it last): supplier_payments_purchase_supplier_fk
-- below references this pair, and Postgres refuses an FK whose target has no matching unique
-- constraint yet. Additive and catalog-light on an existing table; the previous release never
-- changes purchases.supplier_id on a purchase that has a payment, because none exist for it.
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_id_supplier_id_key" UNIQUE("id","supplier_id");--> statement-breakpoint
ALTER TABLE "private_files" ADD CONSTRAINT "private_files_uploaded_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("uploaded_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_attachments" ADD CONSTRAINT "purchase_attachments_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_attachments" ADD CONSTRAINT "purchase_attachments_created_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_attachments" ADD CONSTRAINT "purchase_attachments_voided_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("voided_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_attachments" ADD CONSTRAINT "purchase_attachments_file_fk" FOREIGN KEY ("file_id","file_purpose") REFERENCES "public"."private_files"("id","purpose") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_production_batch_id_production_batches_id_fk" FOREIGN KEY ("production_batch_id") REFERENCES "public"."production_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_recorded_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("recorded_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_voided_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("voided_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_purchase_supplier_fk" FOREIGN KEY ("purchase_id","supplier_id") REFERENCES "public"."purchases"("id","supplier_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_proof_file_fk" FOREIGN KEY ("proof_file_id","proof_file_purpose") REFERENCES "public"."private_files"("id","purpose") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "private_files_uploaded_by_staff_user_id_idx" ON "private_files" USING btree ("uploaded_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "private_files_original_sha256_idx" ON "private_files" USING btree ("original_sha256");--> statement-breakpoint
CREATE INDEX "purchase_attachments_purchase_id_created_at_idx" ON "purchase_attachments" USING btree ("purchase_id","created_at");--> statement-breakpoint
CREATE INDEX "purchase_attachments_created_by_staff_user_id_idx" ON "purchase_attachments" USING btree ("created_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "purchase_attachments_voided_by_staff_user_id_idx" ON "purchase_attachments" USING btree ("voided_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_purchase_id_created_at_idx" ON "supplier_payments" USING btree ("purchase_id","created_at");--> statement-breakpoint
CREATE INDEX "supplier_payments_production_batch_id_created_at_idx" ON "supplier_payments" USING btree ("production_batch_id","created_at");--> statement-breakpoint
CREATE INDEX "supplier_payments_supplier_id_idx" ON "supplier_payments" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_paid_at_idx" ON "supplier_payments" USING btree ("paid_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "supplier_payments_recorded_by_staff_user_id_idx" ON "supplier_payments" USING btree ("recorded_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_voided_by_staff_user_id_idx" ON "supplier_payments" USING btree ("voided_by_staff_user_id");--> statement-breakpoint

-- Hand-authored below this line (same idiom as migrations 0008/0024/0037): drizzle-kit does not
-- emit triggers or reference data. docs/plans/purchase-payments.md §4.
--
-- private_files is fully immutable: a stored proof or nota is never re-pointed, renamed or
-- removed (P6, P8). TRUNCATE is deliberately not blocked, same as every other append-only table
-- here (disposable test databases reset with it; CLAUDE.md forbids it on real data).
CREATE OR REPLACE FUNCTION prevent_private_file_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'private_files is immutable; rows are never updated or deleted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS prevent_private_file_mutation ON "private_files";--> statement-breakpoint

CREATE TRIGGER prevent_private_file_mutation BEFORE UPDATE OR DELETE ON "private_files" FOR EACH ROW
  EXECUTE FUNCTION prevent_private_file_mutation();
--> statement-breakpoint

-- supplier_payments and purchase_attachments are append-only except for voiding (P6): DELETE is
-- always rejected, and UPDATE is rejected unless the only columns changing are voided_at /
-- voided_by_staff_user_id / void_reason, going from NULL, exactly once. Amount, date, method,
-- payee, target, proof and note can therefore never change at the DB level. One function for both
-- tables (they share the three void column names); same shape as
-- prevent_accessory_movement_mutation (migration 0008). The triple CHECK on each table makes the
-- void all-three-or-none with a non-blank reason.
CREATE OR REPLACE FUNCTION prevent_voidable_record_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only; rows are never deleted (void instead)', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION '% row % has already been voided and can no longer change', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'voided_at' - 'voided_by_staff_user_id' - 'void_reason')
     IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'voided_by_staff_user_id' - 'void_reason') THEN
    RAISE EXCEPTION '% is append-only; only voided_at, voided_by_staff_user_id and void_reason may be set, once', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS prevent_supplier_payment_mutation ON "supplier_payments";--> statement-breakpoint

CREATE TRIGGER prevent_supplier_payment_mutation BEFORE UPDATE OR DELETE ON "supplier_payments" FOR EACH ROW
  EXECUTE FUNCTION prevent_voidable_record_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS prevent_purchase_attachment_mutation ON "purchase_attachments";--> statement-breakpoint

CREATE TRIGGER prevent_purchase_attachment_mutation BEFORE UPDATE OR DELETE ON "purchase_attachments" FOR EACH ROW
  EXECUTE FUNCTION prevent_voidable_record_mutation();
--> statement-breakpoint

-- P10: the new supplier_payments.manage permission (record and void supplier payments, view
-- payment proofs). Reference data the code matches by literal key, so it ships here, not only in
-- seed.ts (CLAUDE.md; same pattern as migrations 0012/0024). Granted to super_admin and owner (it
-- is not in OWNER_EXCLUDED_PERMISSION_KEYS). Idempotent: ON CONFLICT DO NOTHING on both inserts.
INSERT INTO "permissions" ("key", "description", "group")
VALUES ('supplier_payments.manage', 'Record and void supplier payments, and view payment proofs', 'finance')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r, "permissions" p
WHERE r."key" IN ('super_admin', 'owner') AND p."key" = 'supplier_payments.manage'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
