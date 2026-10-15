CREATE TABLE "size_chart_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"size_chart_id" uuid NOT NULL,
	"size" text NOT NULL,
	"bust_cm" integer NOT NULL,
	"length_cm" integer NOT NULL,
	"sleeve_length_cm" integer NOT NULL,
	"height_recommendation_min_cm" integer NOT NULL,
	"height_recommendation_max_cm" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "size_chart_rows_size_chart_id_size_key" UNIQUE("size_chart_id","size"),
	CONSTRAINT "size_chart_rows_size_check" CHECK ("size_chart_rows"."size" in ('XS', 'S', 'M', 'L', 'XL', 'ALLSIZE')),
	CONSTRAINT "size_chart_rows_size_not_allsize_check" CHECK ("size_chart_rows"."size" <> 'ALLSIZE'),
	CONSTRAINT "size_chart_rows_bust_cm_check" CHECK ("size_chart_rows"."bust_cm" > 0),
	CONSTRAINT "size_chart_rows_length_cm_check" CHECK ("size_chart_rows"."length_cm" > 0),
	CONSTRAINT "size_chart_rows_sleeve_length_cm_check" CHECK ("size_chart_rows"."sleeve_length_cm" > 0),
	CONSTRAINT "size_chart_rows_height_recommendation_min_cm_check" CHECK ("size_chart_rows"."height_recommendation_min_cm" > 0),
	CONSTRAINT "size_chart_rows_height_recommendation_max_cm_check" CHECK ("size_chart_rows"."height_recommendation_max_cm" > 0),
	CONSTRAINT "size_chart_rows_height_recommendation_range_check" CHECK ("size_chart_rows"."height_recommendation_max_cm" >= "size_chart_rows"."height_recommendation_min_cm")
);
--> statement-breakpoint
CREATE TABLE "size_charts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storefront_homepage_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"draft_is_visible" boolean DEFAULT true NOT NULL,
	"draft_content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"draft_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_is_visible" boolean,
	"published_content" jsonb,
	"published_at" timestamp with time zone,
	"published_by_staff_user_id" uuid,
	CONSTRAINT "storefront_homepage_sections_key_unique" UNIQUE("key"),
	CONSTRAINT "storefront_homepage_sections_key_check" CHECK ("storefront_homepage_sections"."key" in ('hero', 'product_grid', 'feature_block', 'why_ammari'))
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_published_on_storefront" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "storefront_description" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "allsize_fit_note" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "size_chart_id" uuid;--> statement-breakpoint
ALTER TABLE "size_chart_rows" ADD CONSTRAINT "size_chart_rows_size_chart_id_size_charts_id_fk" FOREIGN KEY ("size_chart_id") REFERENCES "public"."size_charts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_homepage_sections" ADD CONSTRAINT "storefront_homepage_sections_published_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("published_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "size_chart_rows_size_chart_id_idx" ON "size_chart_rows" USING btree ("size_chart_id");--> statement-breakpoint
CREATE INDEX "storefront_homepage_sections_published_by_staff_user_id_idx" ON "storefront_homepage_sections" USING btree ("published_by_staff_user_id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_size_chart_id_size_charts_id_fk" FOREIGN KEY ("size_chart_id") REFERENCES "public"."size_charts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_size_chart_id_idx" ON "products" USING btree ("size_chart_id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_is_published_on_storefront_active_check" CHECK ((not "products"."is_published_on_storefront") or "products"."is_active");--> statement-breakpoint

-- Everything below is hand-authored, no schema.ts diff (same category as 0012/0014) —
-- `drizzle-kit generate` has nothing to emit for data, only for the table/column changes above.

-- New permission "content.manage" (packages/db/src/rbac/permissions.ts), granted to
-- super_admin (always) and owner (not in OWNER_EXCLUDED_PERMISSION_KEYS) — same pattern as
-- migration 0012's own grant. Idempotent (ON CONFLICT DO NOTHING on both inserts) and safe to
-- run against a database a `db:seed` run already landed this on (seed.ts's syncPermissionCatalog
-- picks up the same PERMISSIONS entry automatically; this migration is what makes it land on
-- dev/prod/a human's local db that db:seed never touches again after first run — see
-- rbac/permissions.ts's own doc comment and CLAUDE.md's database rule).
INSERT INTO "permissions" ("key", "description", "group")
VALUES (
  'content.manage',
  'Manage storefront content: homepage sections, product publish/description/size chart, size charts',
  'content'
)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r, "permissions" p
WHERE r."key" IN ('super_admin', 'owner') AND p."key" = 'content.manage'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;--> statement-breakpoint

-- The homepage's 4 fixed section rows (schema/content.ts's own doc comment explains why these
-- must be seeded by a migration, not seed.ts — the storefront needs them to exist in order to
-- render at all). `draft_content`/`draft_is_visible` take the column defaults ('{}'::jsonb,
-- true); `published_*` stays null (unpublished) until the first "Terbitkan" action (a later
-- session). Idempotent — ON CONFLICT ("key") DO NOTHING, safe to run against a database that
-- already has these 4 rows.
INSERT INTO "storefront_homepage_sections" ("key") VALUES
  ('hero'),
  ('product_grid'),
  ('feature_block'),
  ('why_ammari')
ON CONFLICT ("key") DO NOTHING;