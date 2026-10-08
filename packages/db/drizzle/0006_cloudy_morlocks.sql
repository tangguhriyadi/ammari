ALTER TABLE "production_batch_items" DROP CONSTRAINT "production_batch_items_production_batch_id_production_batches_id_fk";
--> statement-breakpoint
ALTER TABLE "production_batch_items" DROP CONSTRAINT "production_batch_items_sku_product_variants_sku_fk";
--> statement-breakpoint
DROP INDEX "stock_movements_sku_idx";--> statement-breakpoint
ALTER TABLE "production_batch_items" ALTER COLUMN "unit_cost_amount" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "production_batch_items" ADD COLUMN "fabric_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN "posted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN "posted_by_staff_user_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_posted_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("posted_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "production_batches_status_idx" ON "production_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "stock_movements_sku_created_at_idx" ON "stock_movements" USING btree ("sku","created_at");--> statement-breakpoint
-- These two UNIQUE constraints MUST precede the composite FKs below that reference them —
-- drizzle-kit generated them in field-declaration order (after the FKs), which Postgres rejects
-- (a FK's referenced columns must already be covered by a unique constraint). Reordered by hand;
-- see CLAUDE.md's "always read the generated migration file" rule.
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_sku_fabric_id_key" UNIQUE("sku","fabric_id");--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_id_fabric_id_key" UNIQUE("id","fabric_id");--> statement-breakpoint
ALTER TABLE "production_batch_items" ADD CONSTRAINT "production_batch_items_batch_fabric_fk" FOREIGN KEY ("production_batch_id","fabric_id") REFERENCES "public"."production_batches"("id","fabric_id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "production_batch_items" ADD CONSTRAINT "production_batch_items_sku_fabric_fk" FOREIGN KEY ("sku","fabric_id") REFERENCES "public"."product_variants"("sku","fabric_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_status_check" CHECK ("production_batches"."status" in ('draft', 'posted'));--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_status_posted_pair_check" CHECK (("production_batches"."status" = 'posted') = ("production_batches"."posted_at" is not null) and ("production_batches"."status" = 'posted') = ("production_batches"."posted_by_staff_user_id" is not null));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason_check" CHECK ("stock_movements"."reason" in ('recount', 'damaged', 'lost', 'other'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason_adjustment_pair_check" CHECK (("stock_movements"."type" = 'adjustment') = ("stock_movements"."reason" is not null));