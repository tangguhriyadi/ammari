CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" "citext" NOT NULL,
	"kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"phone" text,
	"address" text,
	"bank_name" text,
	"bank_account_no" text,
	"bank_account_name" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_name_unique" UNIQUE("name"),
	CONSTRAINT "suppliers_kinds_allowed_check" CHECK ("suppliers"."kinds" <@ ARRAY['fabric', 'accessory', 'service', 'other']::text[]),
	CONSTRAINT "suppliers_kinds_no_duplicates_check" CHECK (not text_array_has_duplicates("suppliers"."kinds")),
	CONSTRAINT "suppliers_kinds_max_check" CHECK (cardinality("suppliers"."kinds") <= 4)
);
--> statement-breakpoint

-- Hand-authored below this line (same idiom as migrations 0004/0007/0008): drizzle-kit does not
-- emit triggers.
--
-- suppliers is a new mutable table — same auto-maintained updated_at every other mutable table
-- has, which is what packages/db/src/schema/columns.ts's timestamps() helper documents as the
-- contract ("kept in sync by the shared set_updated_at() trigger, not by the application").
-- set_updated_at() already exists, from migration 0001.
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "suppliers" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
