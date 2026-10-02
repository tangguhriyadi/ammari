CREATE TABLE "fabric_colors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fabric_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"supplier_color_code" text,
	"hex" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fabric_colors_fabric_id_name_key" UNIQUE("fabric_id","name"),
	CONSTRAINT "fabric_colors_id_fabric_id_key" UNIQUE("id","fabric_id"),
	CONSTRAINT "fabric_colors_hex_check" CHECK ("fabric_colors"."hex" ~ '^#[0-9A-F]{6}$')
);
--> statement-breakpoint
ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_product_color_size_key";--> statement-breakpoint
ALTER TABLE "fabrics" DROP CONSTRAINT "fabrics_price_per_meter_amount_check";--> statement-breakpoint
ALTER TABLE "fabrics" DROP CONSTRAINT "fabrics_roll_length_cm_check";--> statement-breakpoint
ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_size_check";--> statement-breakpoint
ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_product_id_products_id_fk";
--> statement-breakpoint
ALTER TABLE "fabrics" ADD COLUMN "price_amount" bigint;--> statement-breakpoint
ALTER TABLE "fabrics" ADD COLUMN "price_unit" text;--> statement-breakpoint
ALTER TABLE "fabrics" ADD COLUMN "care_instructions" text;--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "fabric_color_id" uuid;--> statement-breakpoint
-- All five NOT NULL columns below are added nullable first, backfilled, then locked — this
-- migration is NOT assumed to run against empty tables: `products`, `product_variants`,
-- `fabrics` and `product_images` all existed at 0003 and may already hold real rows.
ALTER TABLE "product_variants" ADD COLUMN "fabric_id" uuid;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "fabric_color_id" uuid;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "closure" text;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "size_mode" text;--> statement-breakpoint

-- ---------- Backfill (in dependency order: fabric_colors rows must exist before variants can
-- reference one; products.code/size_mode have no predecessor column, so they're derived) ----------

-- 1. Carry forward any existing per-meter price instead of silently losing it — fabrics.price_unit
-- didn't exist before, but every pre-existing price was implicitly "per meter" (the only unit this
-- schema ever supported until now).
UPDATE "fabrics" SET "price_amount" = "price_per_meter_amount", "price_unit" = 'meter'
  WHERE "price_per_meter_amount" IS NOT NULL;--> statement-breakpoint

-- 2. One fabric_colors row per distinct (fabric, color name) pair found in the about-to-be-dropped
-- free-text color columns on product_variants and product_images. product_variants.color was
-- NOT NULL at 0003 (every variant has one); product_images.color was always nullable. Neither
-- table had a color_hex-equivalent at 0003 (color_hex was added and removed entirely within the
-- squashed 0004-0007 range), so there is no hex to carry forward — backfilled colors get hex =
-- NULL (the neutral placeholder swatch), same as any other color an admin adds without a hex.
INSERT INTO "fabric_colors" ("fabric_id", "name")
  SELECT DISTINCT p."fabric_id", pv."color"
  FROM "product_variants" pv
  JOIN "products" p ON p."id" = pv."product_id"
  ON CONFLICT ("fabric_id", "name") DO NOTHING;--> statement-breakpoint
INSERT INTO "fabric_colors" ("fabric_id", "name")
  SELECT DISTINCT p."fabric_id", pi."color"
  FROM "product_images" pi
  JOIN "products" p ON p."id" = pi."product_id"
  WHERE pi."color" IS NOT NULL
  ON CONFLICT ("fabric_id", "name") DO NOTHING;--> statement-breakpoint

-- 3. product_variants.fabric_id and .closure are plain copies of their own product's current
-- values — both columns already existed (and were NOT NULL) on `products` since 0000.
UPDATE "product_variants" pv SET "fabric_id" = p."fabric_id", "closure" = p."closure"
  FROM "products" p WHERE p."id" = pv."product_id";--> statement-breakpoint

-- 4. Match each variant's old free-text color to the fabric_colors row created for it in step 2.
-- pv.color is plain `text`, not citext — `fc.name = pv.color` resolves to the ordinary
-- case-SENSITIVE text "=" operator (verified directly: 'Sage'::citext = 'sage'::text is false),
-- not citext's case-insensitive one, so pv.color is cast to citext explicitly here to force the
-- case-insensitive comparison the app itself relies on (fabric_colors.name's own uniqueness is
-- citext-based, so "Sage" and "sage" are the SAME color and must both match the one row that
-- survived step 2's ON CONFLICT DO NOTHING).
UPDATE "product_variants" pv SET "fabric_color_id" = fc."id"
  FROM "products" p, "fabric_colors" fc
  WHERE p."id" = pv."product_id" AND fc."fabric_id" = p."fabric_id" AND fc."name" = pv."color"::citext;--> statement-breakpoint

-- 5. Same match for product_images (fabric_color_id stays nullable here, so this is a data-fidelity
-- backfill, not a NOT NULL requirement). Same explicit citext cast as step 4, same reason.
UPDATE "product_images" pi SET "fabric_color_id" = fc."id"
  FROM "products" p, "fabric_colors" fc
  WHERE p."id" = pi."product_id" AND fc."fabric_id" = p."fabric_id" AND fc."name" = pi."color"::citext
    AND pi."color" IS NOT NULL;--> statement-breakpoint

-- 6. size_mode never existed before this migration, and ALLSIZE was never a valid `size` value
-- before it either (the old CHECK only allowed XS/S/M/L/XL) — so every pre-existing product's
-- variants are necessarily all sized, making 'sized' the only correct backfill value.
UPDATE "products" SET "size_mode" = 'sized' WHERE "size_mode" IS NULL;--> statement-breakpoint

-- 7. code has no predecessor column; derive it approximately the way the app does (uppercase,
-- alnum-only, "PRODUK" fallback — see packages/db/src/catalog/codes.ts's generateProductCode),
-- with a numeric suffix to keep it unique (required by products_code_unique below) when two
-- existing products would otherwise derive the same code. Not byte-identical: SQL has no
-- equivalent of generateProductCode's NFKD diacritic-stripping step, so e.g. "Café" backfills to
-- CAF (accented character dropped) rather than the app's CAFE (accent stripped, letter kept) —
-- harmless (uniqueness still holds via the suffix below) and only affects pre-existing non-ASCII
-- names at the moment of this one-time backfill; every product created after this migration goes
-- through the real generateProductCode.
UPDATE "products" p SET "code" = sub."code" FROM (
  SELECT
    "id",
    coalesce(nullif(upper(regexp_replace("name", '[^a-zA-Z0-9]', '', 'g')), ''), 'PRODUK')
      || CASE
           WHEN row_number() OVER (
                  PARTITION BY coalesce(nullif(upper(regexp_replace("name", '[^a-zA-Z0-9]', '', 'g')), ''), 'PRODUK')
                  ORDER BY "id"
                ) > 1
           THEN (row_number() OVER (
                  PARTITION BY coalesce(nullif(upper(regexp_replace("name", '[^a-zA-Z0-9]', '', 'g')), ''), 'PRODUK')
                  ORDER BY "id"
                ))::text
           ELSE ''
         END AS "code"
  FROM "products"
) sub WHERE sub."id" = p."id" AND p."code" IS NULL;--> statement-breakpoint

-- ---------- Lock down the backfilled columns ----------
ALTER TABLE "product_variants" ALTER COLUMN "fabric_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product_variants" ALTER COLUMN "fabric_color_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product_variants" ALTER COLUMN "closure" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "size_mode" SET NOT NULL;--> statement-breakpoint

-- ---------- Constraints & indexes ----------
ALTER TABLE "fabric_colors" ADD CONSTRAINT "fabric_colors_fabric_id_fabrics_id_fk" FOREIGN KEY ("fabric_id") REFERENCES "public"."fabrics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fabric_colors_fabric_id_idx" ON "fabric_colors" USING btree ("fabric_id");--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_fabric_color_id_fabric_colors_id_fk" FOREIGN KEY ("fabric_color_id") REFERENCES "public"."fabric_colors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Must exist before the two composite FKs below that reference it (drizzle-kit generates this
-- constraint AFTER the FKs that depend on it — hand-reordered, same bug class as the original
-- 0006/0007 migrations this squash replaces).
ALTER TABLE "products" ADD CONSTRAINT "products_id_fabric_id_closure_key" UNIQUE("id","fabric_id","closure");--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_fabric_closure_fk" FOREIGN KEY ("product_id","fabric_id","closure") REFERENCES "public"."products"("id","fabric_id","closure") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_fabric_color_fabric_fk" FOREIGN KEY ("fabric_color_id","fabric_id") REFERENCES "public"."fabric_colors"("id","fabric_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "product_images_fabric_color_id_idx" ON "product_images" USING btree ("fabric_color_id");--> statement-breakpoint
CREATE INDEX "product_variants_product_id_is_active_idx" ON "product_variants" USING btree ("product_id","is_active");--> statement-breakpoint
CREATE INDEX "product_variants_fabric_color_id_idx" ON "product_variants" USING btree ("fabric_color_id");--> statement-breakpoint
ALTER TABLE "fabrics" DROP COLUMN "price_per_meter_amount";--> statement-breakpoint
ALTER TABLE "fabrics" DROP COLUMN "roll_length_cm";--> statement-breakpoint
ALTER TABLE "product_images" DROP COLUMN "color";--> statement-breakpoint
ALTER TABLE "product_variants" DROP COLUMN "color";--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_color_size_key" UNIQUE("product_id","fabric_color_id","size");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_code_unique" UNIQUE("code");--> statement-breakpoint
ALTER TABLE "fabrics" ADD CONSTRAINT "fabrics_price_amount_check" CHECK ("fabrics"."price_amount" >= 0);--> statement-breakpoint
ALTER TABLE "fabrics" ADD CONSTRAINT "fabrics_price_unit_check" CHECK ("fabrics"."price_unit" in ('meter', 'yard'));--> statement-breakpoint
ALTER TABLE "fabrics" ADD CONSTRAINT "fabrics_price_amount_unit_pair_check" CHECK (("fabrics"."price_amount" is null) = ("fabrics"."price_unit" is null));--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_closure_check" CHECK ("product_variants"."closure" in ('front_zip', 'back_zip'));--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_size_check" CHECK ("product_variants"."size" in ('XS', 'S', 'M', 'L', 'XL', 'ALLSIZE'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_size_mode_check" CHECK ("products"."size_mode" in ('sized', 'all_size'));--> statement-breakpoint

-- ---------- Hand-authored (not expressible in Drizzle's schema DSL) ----------

-- A 'sized' product may only get XS/S/M/L/XL variants; an 'all_size' product may only get an
-- ALLSIZE variant. Application code (apps/admin) rejects this up front for a friendly error, but
-- this trigger is the actual guarantee — it holds even against a bug or a direct write that skips
-- the application layer. The UPDATE trigger is narrowed to fire only when `size` or `product_id`
-- actually changes, so every other UPDATE this table sees (price override, min stock, is_active
-- toggles) doesn't re-run the parent-row SELECT for no reason.
CREATE OR REPLACE FUNCTION enforce_variant_size_mode()
RETURNS trigger AS $$
DECLARE
  product_size_mode text;
BEGIN
  SELECT size_mode INTO product_size_mode FROM "products" WHERE id = NEW.product_id;

  IF product_size_mode = 'sized' AND NEW.size = 'ALLSIZE' THEN
    RAISE EXCEPTION 'product requires a sized variant (XS-XL), not ALLSIZE'
      USING ERRCODE = 'check_violation';
  ELSIF product_size_mode = 'all_size' AND NEW.size <> 'ALLSIZE' THEN
    RAISE EXCEPTION 'product requires an ALLSIZE variant, not a sized variant'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER enforce_variant_size_mode BEFORE INSERT ON "product_variants" FOR EACH ROW EXECUTE FUNCTION enforce_variant_size_mode();--> statement-breakpoint

CREATE TRIGGER enforce_variant_size_mode_on_update BEFORE UPDATE ON "product_variants" FOR EACH ROW
  WHEN (NEW.size IS DISTINCT FROM OLD.size OR NEW.product_id IS DISTINCT FROM OLD.product_id)
  EXECUTE FUNCTION enforce_variant_size_mode();
--> statement-breakpoint

-- Reuses set_updated_at() from 0001_rbac_triggers.sql — fabric_colors is a new mutable table and
-- needs the same auto-maintained updated_at every other mutable table has.
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "fabric_colors" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
