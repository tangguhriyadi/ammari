CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_staff_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"description" text NOT NULL,
	"group" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" "citext" NOT NULL,
	"role_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "fabrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"supplier" text,
	"composition" text,
	"price_per_meter_amount" bigint,
	"roll_length_cm" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fabrics_price_per_meter_amount_check" CHECK ("fabrics"."price_per_meter_amount" >= 0),
	CONSTRAINT "fabrics_roll_length_cm_check" CHECK ("fabrics"."roll_length_cm" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"color" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"sku" text PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"color" text NOT NULL,
	"size" text NOT NULL,
	"price_override_amount" bigint,
	"min_stock_qty" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_variants_product_color_size_key" UNIQUE("product_id","color","size"),
	CONSTRAINT "product_variants_size_check" CHECK ("product_variants"."size" in ('XS', 'S', 'M', 'L', 'XL')),
	CONSTRAINT "product_variants_price_override_amount_check" CHECK ("product_variants"."price_override_amount" >= 0),
	CONSTRAINT "product_variants_min_stock_qty_check" CHECK ("product_variants"."min_stock_qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "production_batch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_batch_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_cost_amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_batch_items_batch_sku_key" UNIQUE("production_batch_id","sku"),
	CONSTRAINT "production_batch_items_qty_check" CHECK ("production_batch_items"."qty" > 0),
	CONSTRAINT "production_batch_items_unit_cost_amount_check" CHECK ("production_batch_items"."unit_cost_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "production_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fabric_id" uuid NOT NULL,
	"batch_no" text NOT NULL,
	"produced_at" date NOT NULL,
	"roll_count" integer NOT NULL,
	"fabric_cost_amount" bigint DEFAULT 0 NOT NULL,
	"sewing_cost_amount" bigint DEFAULT 0 NOT NULL,
	"other_cost_amount" bigint DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_batches_batch_no_unique" UNIQUE("batch_no"),
	CONSTRAINT "production_batches_roll_count_check" CHECK ("production_batches"."roll_count" > 0),
	CONSTRAINT "production_batches_fabric_cost_amount_check" CHECK ("production_batches"."fabric_cost_amount" >= 0),
	CONSTRAINT "production_batches_sewing_cost_amount_check" CHECK ("production_batches"."sewing_cost_amount" >= 0),
	CONSTRAINT "production_batches_other_cost_amount_check" CHECK ("production_batches"."other_cost_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"fabric_id" uuid NOT NULL,
	"closure" text NOT NULL,
	"base_price" bigint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug"),
	CONSTRAINT "products_closure_check" CHECK ("products"."closure" in ('front_zip', 'back_zip')),
	CONSTRAINT "products_base_price_check" CHECK ("products"."base_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"qty" integer NOT NULL,
	"type" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text,
	"created_by_staff_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_qty_check" CHECK ("stock_movements"."qty" <> 0),
	CONSTRAINT "stock_movements_type_check" CHECK ("stock_movements"."type" in ('production', 'sale', 'return', 'adjustment')),
	CONSTRAINT "stock_movements_ref_type_check" CHECK ("stock_movements"."ref_type" in ('production_batch_item', 'order_item', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "ad_spend_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"channel_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"attributed_revenue_amount" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_spend_daily_date_channel_id_key" UNIQUE("date","channel_id"),
	CONSTRAINT "ad_spend_daily_amount_check" CHECK ("ad_spend_daily"."amount" >= 0),
	CONSTRAINT "ad_spend_daily_attributed_revenue_amount_check" CHECK ("ad_spend_daily"."attributed_revenue_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_id_check" CHECK ("channels"."id" in ('shopee', 'tiktok', 'web', 'reseller'))
);
--> statement-breakpoint
CREATE TABLE "cost_assumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"effective_from" date NOT NULL,
	"marketplace_fee_bps" integer NOT NULL,
	"ads_bps" integer NOT NULL,
	"returns_reserve_bps" integer NOT NULL,
	"target_profit_bps" integer NOT NULL,
	"packaging_cost_amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_assumptions_effective_from_unique" UNIQUE("effective_from"),
	CONSTRAINT "cost_assumptions_marketplace_fee_bps_check" CHECK ("cost_assumptions"."marketplace_fee_bps" between 0 and 10000),
	CONSTRAINT "cost_assumptions_ads_bps_check" CHECK ("cost_assumptions"."ads_bps" between 0 and 10000),
	CONSTRAINT "cost_assumptions_returns_reserve_bps_check" CHECK ("cost_assumptions"."returns_reserve_bps" between 0 and 10000),
	CONSTRAINT "cost_assumptions_target_profit_bps_check" CHECK ("cost_assumptions"."target_profit_bps" between 0 and 10000),
	CONSTRAINT "cost_assumptions_packaging_cost_amount_check" CHECK ("cost_assumptions"."packaging_cost_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"category" text NOT NULL,
	"amount" bigint NOT NULL,
	"description" text,
	"created_by_staff_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_category_check" CHECK ("expenses"."category" in ('packaging', 'shipping', 'tools', 'salary', 'operational', 'other')),
	CONSTRAINT "expenses_amount_check" CHECK ("expenses"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" text NOT NULL,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"row_count" integer,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batches_kind_check" CHECK ("import_batches"."kind" in ('orders', 'income')),
	CONSTRAINT "import_batches_status_check" CHECK ("import_batches"."status" in ('pending', 'previewed', 'committed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price" bigint NOT NULL,
	"unit_cost" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_order_id_sku_key" UNIQUE("order_id","sku"),
	CONSTRAINT "order_items_qty_check" CHECK ("order_items"."qty" > 0),
	CONSTRAINT "order_items_unit_price_check" CHECK ("order_items"."unit_price" >= 0),
	CONSTRAINT "order_items_unit_cost_check" CHECK ("order_items"."unit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"import_batch_id" uuid,
	"settled_at" timestamp with time zone NOT NULL,
	"gross_amount" bigint NOT NULL,
	"fee_amount" bigint NOT NULL,
	"net_amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_settlements_order_id_external_ref_key" UNIQUE("order_id","external_ref"),
	CONSTRAINT "order_settlements_net_amount_balance_check" CHECK ("order_settlements"."net_amount" = "order_settlements"."gross_amount" - "order_settlements"."fee_amount")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" text NOT NULL,
	"channel_order_no" text NOT NULL,
	"status" text DEFAULT 'to_ship' NOT NULL,
	"customer_id" uuid,
	"buyer_username" text,
	"order_date" timestamp with time zone NOT NULL,
	"shipped_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"subtotal_amount" bigint NOT NULL,
	"shipping_amount" bigint DEFAULT 0 NOT NULL,
	"discount_amount" bigint DEFAULT 0 NOT NULL,
	"total_amount" bigint NOT NULL,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_channel_id_channel_order_no_key" UNIQUE("channel_id","channel_order_no"),
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" in ('awaiting_payment', 'to_ship', 'shipped', 'completed', 'cancelled', 'returned')),
	CONSTRAINT "orders_subtotal_amount_check" CHECK ("orders"."subtotal_amount" >= 0),
	CONSTRAINT "orders_shipping_amount_check" CHECK ("orders"."shipping_amount" >= 0),
	CONSTRAINT "orders_discount_amount_check" CHECK ("orders"."discount_amount" >= 0),
	CONSTRAINT "orders_total_amount_check" CHECK ("orders"."total_amount" >= 0),
	CONSTRAINT "orders_total_amount_balance_check" CHECK ("orders"."total_amount" = "orders"."subtotal_amount" + "orders"."shipping_amount" - "orders"."discount_amount")
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"month" date NOT NULL,
	"revenue_target_amount" bigint NOT NULL,
	"units_target" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "targets_month_unique" UNIQUE("month"),
	CONSTRAINT "targets_month_first_of_month_check" CHECK ("targets"."month" = date_trunc('month', "targets"."month"::date)::date),
	CONSTRAINT "targets_revenue_target_amount_check" CHECK ("targets"."revenue_target_amount" >= 0),
	CONSTRAINT "targets_units_target_check" CHECK ("targets"."units_target" >= 0)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"email" "citext" NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'retail' NOT NULL,
	"phone_verified_at" timestamp with time zone,
	"email_verified_at" timestamp with time zone,
	"pdp_consent_at" timestamp with time zone NOT NULL,
	"promo_consent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_phone_unique" UNIQUE("phone"),
	CONSTRAINT "customers_email_unique" UNIQUE("email"),
	CONSTRAINT "customers_type_check" CHECK ("customers"."type" in ('retail', 'reseller')),
	CONSTRAINT "customers_phone_format_check" CHECK ("customers"."phone" ~ '^\+62[0-9]{8,13}$')
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination" "citext" NOT NULL,
	"purpose" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"requester_ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_codes_purpose_check" CHECK ("otp_codes"."purpose" in ('staff_login', 'customer_login', 'voucher_claim')),
	CONSTRAINT "otp_codes_attempts_check" CHECK ("otp_codes"."attempts" <= 5)
);
--> statement-breakpoint
CREATE TABLE "thank_you_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"claim_deadline" timestamp with time zone NOT NULL,
	"printed_by_staff_user_id" uuid NOT NULL,
	"claimed_by_customer_id" uuid,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thank_you_cards_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "thank_you_cards_status_check" CHECK ("thank_you_cards"."status" in ('active', 'claimed', 'void')),
	CONSTRAINT "thank_you_cards_claimed_consistency_check" CHECK (("thank_you_cards"."status" = 'claimed') = ("thank_you_cards"."claimed_by_customer_id" is not null and "thank_you_cards"."claimed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"amount" bigint DEFAULT 20000 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_order_id" uuid,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vouchers_card_id_unique" UNIQUE("card_id"),
	CONSTRAINT "vouchers_used_order_id_unique" UNIQUE("used_order_id"),
	CONSTRAINT "vouchers_status_check" CHECK ("vouchers"."status" in ('active', 'used', 'expired', 'void')),
	CONSTRAINT "vouchers_amount_check" CHECK ("vouchers"."amount" >= 0),
	CONSTRAINT "vouchers_expires_after_issued_check" CHECK ("vouchers"."expires_at" > "vouchers"."issued_at"),
	CONSTRAINT "vouchers_used_consistency_check" CHECK (("vouchers"."status" = 'used') = ("vouchers"."used_order_id" is not null and "vouchers"."used_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_staff_user_id_staff_users_id_fk" FOREIGN KEY ("actor_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batch_items" ADD CONSTRAINT "production_batch_items_production_batch_id_production_batches_id_fk" FOREIGN KEY ("production_batch_id") REFERENCES "public"."production_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batch_items" ADD CONSTRAINT "production_batch_items_sku_product_variants_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."product_variants"("sku") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_fabric_id_fabrics_id_fk" FOREIGN KEY ("fabric_id") REFERENCES "public"."fabrics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_fabric_id_fabrics_id_fk" FOREIGN KEY ("fabric_id") REFERENCES "public"."fabrics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_sku_product_variants_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."product_variants"("sku") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_spend_daily" ADD CONSTRAINT "ad_spend_daily_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_uploaded_by_staff_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sku_product_variants_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."product_variants"("sku") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thank_you_cards" ADD CONSTRAINT "thank_you_cards_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thank_you_cards" ADD CONSTRAINT "thank_you_cards_printed_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("printed_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thank_you_cards" ADD CONSTRAINT "thank_you_cards_claimed_by_customer_id_customers_id_fk" FOREIGN KEY ("claimed_by_customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_card_id_thank_you_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."thank_you_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_used_order_id_orders_id_fk" FOREIGN KEY ("used_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_staff_user_id_idx" ON "audit_log" USING btree ("actor_staff_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions" USING btree ("permission_id");--> statement-breakpoint
CREATE INDEX "staff_users_role_id_idx" ON "staff_users" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "product_images_product_id_idx" ON "product_images" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_variants_product_id_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "production_batch_items_production_batch_id_idx" ON "production_batch_items" USING btree ("production_batch_id");--> statement-breakpoint
CREATE INDEX "production_batch_items_sku_idx" ON "production_batch_items" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "production_batches_fabric_id_idx" ON "production_batches" USING btree ("fabric_id");--> statement-breakpoint
CREATE INDEX "products_fabric_id_idx" ON "products" USING btree ("fabric_id");--> statement-breakpoint
CREATE INDEX "stock_movements_sku_idx" ON "stock_movements" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "stock_movements_ref_idx" ON "stock_movements" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "stock_movements_created_by_staff_user_id_idx" ON "stock_movements" USING btree ("created_by_staff_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_type_ref_unique_idx" ON "stock_movements" USING btree ("type","ref_type","ref_id") WHERE "stock_movements"."ref_type" in ('order_item', 'production_batch_item');--> statement-breakpoint
CREATE INDEX "ad_spend_daily_channel_id_idx" ON "ad_spend_daily" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "expenses_date_idx" ON "expenses" USING btree ("date");--> statement-breakpoint
CREATE INDEX "expenses_created_by_staff_user_id_idx" ON "expenses" USING btree ("created_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "import_batches_channel_id_idx" ON "import_batches" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "import_batches_uploaded_by_idx" ON "import_batches" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "import_batches_status_idx" ON "import_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "order_items_order_id_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_sku_idx" ON "order_items" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "order_settlements_order_id_idx" ON "order_settlements" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_settlements_import_batch_id_idx" ON "order_settlements" USING btree ("import_batch_id");--> statement-breakpoint
CREATE INDEX "orders_customer_id_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_import_batch_id_idx" ON "orders" USING btree ("import_batch_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_completed_at_idx" ON "orders" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "otp_codes_destination_purpose_created_at_idx" ON "otp_codes" USING btree ("destination","purpose","created_at");--> statement-breakpoint
CREATE INDEX "otp_codes_expires_at_idx" ON "otp_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "otp_codes_requester_ip_idx" ON "otp_codes" USING btree ("requester_ip");--> statement-breakpoint
CREATE INDEX "thank_you_cards_order_id_idx" ON "thank_you_cards" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "thank_you_cards_printed_by_staff_user_id_idx" ON "thank_you_cards" USING btree ("printed_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "thank_you_cards_claimed_by_customer_id_idx" ON "thank_you_cards" USING btree ("claimed_by_customer_id");--> statement-breakpoint
CREATE INDEX "thank_you_cards_status_idx" ON "thank_you_cards" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "thank_you_cards_active_order_id_key" ON "thank_you_cards" USING btree ("order_id") WHERE "thank_you_cards"."status" = 'active';--> statement-breakpoint
CREATE INDEX "vouchers_customer_id_idx" ON "vouchers" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "vouchers_status_idx" ON "vouchers" USING btree ("status");