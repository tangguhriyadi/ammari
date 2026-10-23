CREATE TABLE "product_types" (
	"code" text PRIMARY KEY NOT NULL,
	"name" "citext" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_types_name_unique" UNIQUE("name"),
	CONSTRAINT "product_types_code_check" CHECK ("product_types"."code" ~ '^[A-Z][A-Z0-9_]{0,29}$'),
	CONSTRAINT "product_types_name_check" CHECK (btrim("product_types"."name") <> '')
);
--> statement-breakpoint
-- Hand-authored (docs/plans/product-types.md): the one reference row the products column default
-- below depends on. Placed BEFORE the ADD COLUMN/FK so every existing product (backfilled to
-- 'DRESS' by the default) already has a row to reference when the FK is validated. Idempotent;
-- never overwrites a later rename. seed.ts inserts the same row insert-only for test databases
-- that get truncated.
INSERT INTO "product_types" ("code", "name", "sort_order") VALUES ('DRESS', 'Gamis', 0)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
-- NOT NULL + constant DEFAULT (not nullable + backfill): on Postgres 11+ this is catalog-only, it
-- backfills every existing row to 'DRESS', and a previous release that inserts products without
-- naming this column keeps working (CLAUDE.md expand/contract rule). No later NOT NULL step needed.
ALTER TABLE "products" ADD COLUMN "product_type_code" text DEFAULT 'DRESS' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_product_type_code_product_types_code_fk" FOREIGN KEY ("product_type_code") REFERENCES "public"."product_types"("code") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "products_product_type_code_idx" ON "products" USING btree ("product_type_code");--> statement-breakpoint

-- Hand-authored below this line (same idiom as migrations 0004/0022): drizzle-kit does not emit
-- triggers.
--
-- product_types is a new mutable table — same auto-maintained updated_at as every other one
-- (set_updated_at() exists since migration 0001).
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "product_types" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint

-- The code is immutable once created (owner decision). The FK's ON UPDATE RESTRICT already
-- blocks renaming a code that a product uses; this also covers a type nothing uses yet, so the
-- rule doesn't depend on usage.
CREATE OR REPLACE FUNCTION prevent_product_type_code_change()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'product_types.code is immutable (% -> %)', OLD.code, NEW.code
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_product_type_code_change BEFORE UPDATE ON "product_types" FOR EACH ROW
  WHEN (NEW.code IS DISTINCT FROM OLD.code)
  EXECUTE FUNCTION prevent_product_type_code_change();
--> statement-breakpoint

-- No hard delete, ever (owner decision; "delete" in the admin is is_active = false). Also guards
-- the DRESS row the products column default depends on: an older release inserting a product
-- with that default would fail its FK if DRESS were deleted while unused (e.g. on rollback).
CREATE OR REPLACE FUNCTION prevent_product_type_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'product_types rows are never deleted (%); deactivate instead', OLD.code
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_product_type_delete BEFORE DELETE ON "product_types" FOR EACH ROW
  EXECUTE FUNCTION prevent_product_type_delete();
