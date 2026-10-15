ALTER TABLE "products" ADD COLUMN "highlights" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_highlights_allowed_check" CHECK ("products"."highlights" <@ ARRAY['breathable', 'flowy', 'falls_perfectly', 'cool_fabric', 'not_see_through']::text[]);--> statement-breakpoint
-- Hand-authored (not drizzle-kit generated): Postgres rejects a subquery inside ANY check
-- constraint outright, even one that only reads the row's own column — confirmed directly
-- against this exact migration's target version, not assumed from the docs — so "no
-- duplicates" is expressed through this tiny IMMUTABLE SQL function instead. Same
-- "hand-authored addition to an auto-generated migration" idiom migration 0001 already used
-- for its own set_updated_at() trigger function.
CREATE FUNCTION "text_array_has_duplicates"(arr text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(arr) <> cardinality(ARRAY(SELECT DISTINCT unnest(arr)))
$$;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_highlights_no_duplicates_check" CHECK (not text_array_has_duplicates("products"."highlights"));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_highlights_max_check" CHECK (cardinality("products"."highlights") <= 5);