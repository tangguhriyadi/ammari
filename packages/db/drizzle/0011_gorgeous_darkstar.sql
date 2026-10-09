ALTER TABLE "channels" DROP CONSTRAINT "channels_id_check";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "channel_order_no" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "pdp_consent_at" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "stock_movements" ADD COLUMN "value_amount" bigint;--> statement-breakpoint

-- prevent_stock_movement_mutation (migration 0008) rejects ANY update to this append-only
-- table, including this one-time backfill — disabled for the two backfill statements below
-- only, then re-enabled immediately after. Same trigger-disable-then-reenable idiom migration
-- 0010 used around its own production_batch_costs.cost_type backfill.
ALTER TABLE "stock_movements" DISABLE TRIGGER "prevent_stock_movement_mutation";--> statement-breakpoint

-- Pre-existing 'production' rows get a real cost basis: qty * the referenced production batch
-- line's own unit_cost_amount (already computed and stored per line at posting time — see
-- production_batch_items.unitCostAmount's doc comment in catalog.ts). ref_id is `text` (shared
-- across every ref_type) but production_batch_items.id is `uuid`, hence the explicit cast —
-- same idiom apps/admin/src/lib/stock/queries.ts's listStockLedger already uses for this exact
-- join.
UPDATE "stock_movements"
SET "value_amount" = "stock_movements"."qty" * "production_batch_items"."unit_cost_amount"
FROM "production_batch_items"
WHERE "stock_movements"."type" = 'production'
  AND "stock_movements"."ref_type" = 'production_batch_item'
  AND "production_batch_items"."id"::text = "stock_movements"."ref_id";--> statement-breakpoint

-- Any other pre-existing row (e.g. a manual 'adjustment' from before this column existed) has no
-- cost basis we can derive after the fact — backfilled to 0, consistent with "no cost tracked
-- yet" rather than fabricating one.
UPDATE "stock_movements" SET "value_amount" = 0 WHERE "value_amount" IS NULL;--> statement-breakpoint

ALTER TABLE "stock_movements" ENABLE TRIGGER "prevent_stock_movement_mutation";--> statement-breakpoint

ALTER TABLE "stock_movements" ALTER COLUMN "value_amount" SET NOT NULL;--> statement-breakpoint

-- Added directly NOT NULL, no DEFAULT/backfill (unlike value_amount above): the orders feature
-- itself didn't exist before this migration — no code path anywhere in the repo ever inserted
-- into "orders" prior to this session's lib/orders/queries.ts — so this table has 0 rows on
-- every environment this migration can run against. Safe only because of that; a future
-- migration must never assume the same about a table real app code already writes to.
ALTER TABLE "orders" ADD COLUMN "order_no" text NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_address" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "created_by_staff_user_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_created_by_staff_user_id_idx" ON "orders" USING btree ("created_by_staff_user_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_order_no_unique" UNIQUE("order_no");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_id_check" CHECK ("channels"."id" in ('shopee', 'tiktok', 'web', 'reseller', 'whatsapp', 'instagram', 'offline'));
