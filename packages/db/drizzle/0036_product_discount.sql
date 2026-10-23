ALTER TABLE "products" ADD COLUMN "discount_price_amount" bigint;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "list_unit_price" bigint;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_discount_price_amount_check" CHECK ("products"."discount_price_amount" is null or ("products"."discount_price_amount" > 0 and "products"."discount_price_amount" < "products"."base_price" and ("products"."base_price" - "products"."discount_price_amount") * 100 >= "products"."base_price"));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_discount_enabled_price_check" CHECK (not "products"."discount_enabled" or "products"."discount_price_amount" is not null);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_discount_window_check" CHECK ("products"."discount_starts_at" is null or "products"."discount_ends_at" is null or "products"."discount_ends_at" > "products"."discount_starts_at");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_list_unit_price_check" CHECK ("order_items"."list_unit_price" is null or "order_items"."list_unit_price" >= "order_items"."unit_price");