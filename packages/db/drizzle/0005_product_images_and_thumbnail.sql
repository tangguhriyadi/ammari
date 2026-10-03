ALTER TABLE "product_images" DROP CONSTRAINT "product_images_product_id_products_id_fk";
--> statement-breakpoint
ALTER TABLE "product_images" DROP CONSTRAINT "product_images_fabric_color_id_fabric_colors_id_fk";
--> statement-breakpoint
-- Superseded by the composite index below (product_id,fabric_color_id,sort_order), whose
-- leftmost column already serves any product_id-only query (leftmost-prefix rule) — this
-- single-column one (from migration 0000) is now a strict subset with no remaining read
-- benefit, just extra write/storage overhead (database-reviewer finding).
DROP INDEX "product_images_product_id_idx";--> statement-breakpoint
-- product_images has ZERO rows in every environment (no application code has ever written to
-- it — this feature is what introduces the first writer), so fabric_id/width/height can be
-- added directly NOT NULL with no DEFAULT and no nullable->backfill->lock dance, unlike 0004's
-- product_variants columns, which had to account for real pre-existing rows.
ALTER TABLE "product_images" ADD COLUMN "fabric_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "alt_text" text;--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "width" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "height" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "thumbnail_image_id" uuid;--> statement-breakpoint

-- ---------- Constraints & indexes ----------
-- Both UNIQUE constraints below must exist BEFORE the composite FKs that reference them —
-- drizzle-kit generated this file with the FK ahead of its own UNIQUE (same ordering bug its
-- generator has always had, per 0004's own comment on this), hand-reordered here. There is no
-- real circular dependency: neither UNIQUE constraint depends on the other, only each FK
-- depends on one of them, so creating both UNIQUEs first resolves it cleanly.
ALTER TABLE "products" ADD CONSTRAINT "products_id_fabric_id_key" UNIQUE("id","fabric_id");--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_id_product_id_key" UNIQUE("id","product_id");--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_fabric_fk" FOREIGN KEY ("product_id","fabric_id") REFERENCES "public"."products"("id","fabric_id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_fabric_color_fabric_fk" FOREIGN KEY ("fabric_color_id","fabric_id") REFERENCES "public"."fabric_colors"("id","fabric_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "product_images_product_id_fabric_color_id_sort_order_idx" ON "product_images" USING btree ("product_id","fabric_color_id","sort_order");--> statement-breakpoint
-- Indexes the FK-referencing side of products_thumbnail_image_id_fk (hand-authored below) —
-- without it, that FK's RESTRICT check seq-scans all of `products` every time ANY product_images
-- row is deleted, including cascaded deletes (database-reviewer finding; verified with EXPLAIN).
CREATE INDEX "products_thumbnail_image_id_idx" ON "products" USING btree ("thumbnail_image_id");--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_width_check" CHECK ("product_images"."width" > 0);--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_height_check" CHECK ("product_images"."height" > 0);--> statement-breakpoint

-- ---------- Hand-authored (not expressible in Drizzle's schema DSL) ----------

-- "products.thumbnail_image_id must reference an image of this SAME product" — a composite FK,
-- same technique as product_variants_fabric_color_fabric_fk, but not declared in
-- packages/db/src/schema/catalog.ts: product_images is defined further down that file, and
-- drizzle-orm's foreignKey() helper evaluates `foreignColumns` eagerly, so a forward reference
-- to a `const` declared later in the same module throws at import time (verified against
-- drizzle-orm 0.45.3's source). ON DELETE RESTRICT, not SET NULL: a composite FK's SET NULL
-- would null out `id` too (products' own PK, NOT NULL — the action would itself fail the moment
-- anyone deleted a thumbnail image), and Postgres 15+'s column-scoped `ON DELETE SET NULL (col)`
-- syntax has no Drizzle DSL equivalent either. apps/admin's deleteProductImage instead computes
-- the fallback thumbnail and updates this column BEFORE deleting the image row, in the same
-- transaction — required anyway since the fallback rule is app-level business logic, not
-- something a DB trigger should own. RESTRICT is then a free safety net against any future code
-- path that forgets to null this column first (verified empirically, including the
-- self-referencing case — deleting a product whose own thumbnail_image_id points at one of its
-- own images correctly cascades and succeeds, because the cascade's nested delete of
-- product_images fires after the referencing products row is already gone within the same
-- command — database-reviewer finding, confirmed against a throwaway schema).
ALTER TABLE "products" ADD CONSTRAINT "products_thumbnail_image_id_fk" FOREIGN KEY ("thumbnail_image_id","id") REFERENCES "public"."product_images"("id","product_id") ON DELETE restrict ON UPDATE restrict;
