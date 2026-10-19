DROP INDEX "stock_movements_type_ref_unique_idx";--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN "receipt_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN "closed_by_staff_user_id" uuid;--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN "close_reason" text;--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_closed_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("closed_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "production_batches_receipt_status_idx" ON "production_batches" USING btree ("receipt_status");--> statement-breakpoint
CREATE INDEX "production_batches_closed_by_staff_user_id_idx" ON "production_batches" USING btree ("closed_by_staff_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_type_ref_unique_idx" ON "stock_movements" USING btree ("type","ref_type","ref_id") WHERE "stock_movements"."ref_type" in ('order_item', 'production_batch_item', 'goods_receipt_item');--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_receipt_status_check" CHECK ("production_batches"."receipt_status" in ('pending', 'partially_received', 'received', 'closed'));--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_draft_receipt_pending_check" CHECK ("production_batches"."status" <> 'draft' or "production_batches"."receipt_status" = 'pending');--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_closed_status_check" CHECK ("production_batches"."receipt_status" <> 'closed' or "production_batches"."closed_at" is not null);--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_closed_pair_check" CHECK (("production_batches"."closed_at" is not null) = ("production_batches"."closed_by_staff_user_id" is not null));--> statement-breakpoint

-- Hand-authored below this line (same idiom as migrations 0004/0007/0008/0012/0022/0024):
-- drizzle-kit does not emit data. docs/plans/suppliers-goods-receipt.md session S4.
--
-- Backward compatibility with the previous release (CLAUDE.md expand/contract): everything above
-- is additive. `production_batches.status` keeps its exact draft/posted domain, so the freeze
-- trigger (prevent_posted_batch_field_change, whose WHEN clause names its columns explicitly) and
-- every read/write of `status` by the previous release are unchanged. The four new columns are
-- defaulted or nullable, so the previous release's INSERT and its post UPDATE (draft -> posted,
-- receipt_status left at its 'pending' default) stay valid against every new CHECK. The widened
-- stock_movements_type_ref_unique_idx predicate is a strict superset of the old one and covers
-- one more ref_type ('goods_receipt_item') that no row carries yet.
--
-- Batches posted by releases before this one already put their output into stock AT POSTING
-- (one 'production' stock_movements row per line, ref_type 'production_batch_item'). They are
-- therefore fully received: mark them so, so the UI never offers a receipt for them and nothing
-- is counted twice. The app ALSO counts those legacy posting rows as received per line
-- (lib/receipts/production.ts), which covers a batch posted by the previous release AFTER this
-- migration ran (rollback window) — the backfill below can't see that one. Idempotent: only
-- touches rows still at the 'pending' default.
UPDATE "production_batches"
SET "receipt_status" = 'received'
WHERE "status" = 'posted' AND "receipt_status" = 'pending';
