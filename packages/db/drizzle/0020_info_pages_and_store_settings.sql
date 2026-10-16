CREATE TABLE "info_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"draft_body" text NOT NULL,
	"draft_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_body" text,
	"published_at" timestamp with time zone,
	"published_by_staff_user_id" uuid,
	CONSTRAINT "info_pages_slug_unique" UNIQUE("slug"),
	CONSTRAINT "info_pages_slug_check" CHECK ("info_pages"."slug" in ('privacy-policy', 'terms-of-service', 'returns-exchange', 'how-to-order', 'shipping'))
);
--> statement-breakpoint
CREATE TABLE "store_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"whatsapp_number" text,
	"support_email" text,
	"business_address" text,
	"return_policy_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_settings_id_check" CHECK ("store_settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "info_pages" ADD CONSTRAINT "info_pages_published_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("published_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "info_pages_published_by_staff_user_id_idx" ON "info_pages" USING btree ("published_by_staff_user_id");

-- Everything below is hand-authored, no schema.ts diff (same category as 0012/0014/0019's own
-- data section) — `drizzle-kit generate` has nothing to emit for data, only for the table/column
-- changes above.

-- The 5 fixed info-page rows (schema/content.ts's own doc comment explains why these must be
-- seeded by a migration, not seed.ts). Idempotent — ON CONFLICT ("slug") DO NOTHING, safe to run
-- against a database that already has these 5 rows, and INSERT-ONLY: a redeploy re-running this
-- file must never touch a row the owner has since edited/published.
--
-- "privacy-policy"/"terms-of-service" are seeded with their CURRENT hard-coded placeholder text
-- (apps/web/src/app/privacy-policy/page.tsx, terms-of-service/page.tsx) in BOTH draft_body and
-- published_body — already "published" on day one, unlike the other 3 slugs, because these two
-- routes are registered in the Google OAuth consent screen and used for payment-gateway
-- verification: the route must never 404 or render blank, even for the one deploy between this
-- migration landing and the owner writing real copy. This is PLACEHOLDER TEXT, not real legal
-- content — the owner must replace it via the admin editor before launch/payment-gateway
-- verification (see this session's own implementation report).
--
-- "returns-exchange"/"how-to-order"/"shipping" start with an empty draft_body and a null
-- published_body (unpublished) — apps/web's info-page route renders a "sedang disiapkan" state
-- for an unpublished page rather than a blank one, so there is nothing unsafe about starting
-- empty, same as the homepage sections' own `{}`-until-first-publish contract.
INSERT INTO "info_pages" ("slug", "title", "draft_body", "published_body", "published_at") VALUES
  (
    'privacy-policy',
    'Kebijakan Privasi',
    '<p>Konten kebijakan privasi Ammari akan dilengkapi di sini sebelum peluncuran. Halaman ini menjelaskan bagaimana Ammari mengumpulkan, menggunakan, dan melindungi data pribadimu sesuai Undang-Undang Pelindungan Data Pribadi (UU PDP).</p>',
    '<p>Konten kebijakan privasi Ammari akan dilengkapi di sini sebelum peluncuran. Halaman ini menjelaskan bagaimana Ammari mengumpulkan, menggunakan, dan melindungi data pribadimu sesuai Undang-Undang Pelindungan Data Pribadi (UU PDP).</p>',
    now()
  ),
  (
    'terms-of-service',
    'Syarat & Ketentuan',
    '<p>Syarat dan ketentuan penggunaan layanan Ammari, termasuk aturan voucher dan belanja di ammari.id, akan dilengkapi di sini sebelum peluncuran.</p>',
    '<p>Syarat dan ketentuan penggunaan layanan Ammari, termasuk aturan voucher dan belanja di ammari.id, akan dilengkapi di sini sebelum peluncuran.</p>',
    now()
  ),
  ('returns-exchange', 'Pengembalian & Penukaran', '', NULL, NULL),
  ('how-to-order', 'Cara Pemesanan', '', NULL, NULL),
  ('shipping', 'Pengiriman', '', NULL, NULL)
ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint

-- The one store_settings row (schema/content.ts's own doc comment explains why this is a real
-- singleton, CHECK'd to id = 1) — every field starts null; the owner fills them in via the admin
-- settings form after this deploys (save = live, no draft/publish). Idempotent AND insert-only
-- for the same reason as the info-page rows above: a redeploy must never touch a row the owner
-- has since filled in.
INSERT INTO "store_settings" ("id") VALUES (1)
ON CONFLICT ("id") DO NOTHING;