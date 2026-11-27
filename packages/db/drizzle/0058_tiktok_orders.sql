CREATE TABLE "tiktok_order_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tiktok_order_id" text NOT NULL,
	"update_time" timestamp with time zone NOT NULL,
	"content_sha256" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tiktok_order_snapshots_version_key" UNIQUE("tiktok_order_id","update_time","content_sha256"),
	CONSTRAINT "tiktok_order_snapshots_source_check" CHECK ("tiktok_order_snapshots"."source" in ('webhook', 'poll', 'backfill', 'manual')),
	CONSTRAINT "tiktok_order_snapshots_sha_check" CHECK ("tiktok_order_snapshots"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tiktok_order_snapshots_order_id_check" CHECK (char_length("tiktok_order_snapshots"."tiktok_order_id") between 1 and 128)
);
--> statement-breakpoint
CREATE TABLE "tiktok_orders" (
	"tiktok_order_id" text PRIMARY KEY NOT NULL,
	"order_id" uuid,
	"status" text NOT NULL,
	"latest_update_time" timestamp with time zone NOT NULL,
	"latest_snapshot_id" uuid NOT NULL,
	"paid_time" timestamp with time zone,
	"collection_time" timestamp with time zone,
	"delivery_time" timestamp with time zone,
	"cancel_time" timestamp with time zone,
	"is_on_hold_order" boolean,
	"rts_sla_time" timestamp with time zone,
	"apply_state" text,
	"held_reason" text,
	"applied_update_time" timestamp with time zone,
	"buyer_message" text,
	"buyer_message_purge_after" timestamp with time zone,
	"review_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tiktok_orders_apply_state_check" CHECK ("tiktok_orders"."apply_state" is null or "tiktok_orders"."apply_state" in ('applied', 'held', 'skipped_unpaid', 'skipped_undone')),
	CONSTRAINT "tiktok_orders_held_reason_check" CHECK ("tiktok_orders"."held_reason" is null or "tiktok_orders"."held_reason" in ('unknown_sku', 'short_stock', 'lines_differ', 'final_in_admin', 'partial_shipping', 'partial_refund', 'unknown_status', 'money_format')),
	CONSTRAINT "tiktok_orders_buyer_message_check" CHECK ("tiktok_orders"."buyer_message" is null or char_length("tiktok_orders"."buyer_message") <= 1000),
	CONSTRAINT "tiktok_orders_status_check" CHECK (char_length("tiktok_orders"."status") between 1 and 64),
	CONSTRAINT "tiktok_orders_review_flags_check" CHECK ("tiktok_orders"."review_flags" <@ ARRAY['tiktok_snapshot_conflict', 'tiktok_left_terminal']::text[])
);
--> statement-breakpoint
CREATE TABLE "tiktok_sku_mappings" (
	"tiktok_sku_id" text PRIMARY KEY NOT NULL,
	"tiktok_product_id" text,
	"seller_sku" text,
	"variant_sku" text NOT NULL,
	"source" text NOT NULL,
	"mapped_by_staff_user_id" uuid,
	"mapped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tiktok_sku_mappings_source_check" CHECK ("tiktok_sku_mappings"."source" in ('auto_seller_sku', 'manual')),
	CONSTRAINT "tiktok_sku_mappings_sku_id_check" CHECK (char_length("tiktok_sku_mappings"."tiktok_sku_id") between 1 and 128),
	CONSTRAINT "tiktok_sku_mappings_actor_check" CHECK (("tiktok_sku_mappings"."source" = 'manual') = ("tiktok_sku_mappings"."mapped_by_staff_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "tiktok_orders" ADD CONSTRAINT "tiktok_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tiktok_orders" ADD CONSTRAINT "tiktok_orders_latest_snapshot_id_tiktok_order_snapshots_id_fk" FOREIGN KEY ("latest_snapshot_id") REFERENCES "public"."tiktok_order_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tiktok_sku_mappings" ADD CONSTRAINT "tiktok_sku_mappings_variant_sku_product_variants_sku_fk" FOREIGN KEY ("variant_sku") REFERENCES "public"."product_variants"("sku") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tiktok_sku_mappings" ADD CONSTRAINT "tiktok_sku_mappings_mapped_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("mapped_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tiktok_orders_order_id_key" ON "tiktok_orders" USING btree ("order_id") WHERE "tiktok_orders"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "tiktok_orders_latest_update_time_idx" ON "tiktok_orders" USING btree ("latest_update_time");--> statement-breakpoint
CREATE INDEX "tiktok_orders_latest_snapshot_id_idx" ON "tiktok_orders" USING btree ("latest_snapshot_id");--> statement-breakpoint
CREATE INDEX "tiktok_orders_buyer_message_purge_idx" ON "tiktok_orders" USING btree ("buyer_message_purge_after") WHERE "tiktok_orders"."buyer_message" is not null;--> statement-breakpoint
CREATE INDEX "tiktok_sku_mappings_variant_sku_idx" ON "tiktok_sku_mappings" USING btree ("variant_sku");--> statement-breakpoint
CREATE INDEX "tiktok_sku_mappings_mapped_by_idx" ON "tiktok_sku_mappings" USING btree ("mapped_by_staff_user_id");