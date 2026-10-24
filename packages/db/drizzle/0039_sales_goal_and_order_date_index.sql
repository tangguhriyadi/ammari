CREATE TABLE "sales_goal" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"revenue_target_amount" bigint DEFAULT 1000000000 NOT NULL,
	"start_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_goal_id_check" CHECK ("sales_goal"."id" = 1),
	CONSTRAINT "sales_goal_revenue_target_amount_check" CHECK ("sales_goal"."revenue_target_amount" > 0)
);
--> statement-breakpoint
CREATE INDEX "orders_order_date_idx" ON "orders" USING btree ("order_date");--> statement-breakpoint

-- Hand-authored below this line (same idiom as migrations 0020/0037): drizzle-kit emits neither
-- triggers nor rows.
--
-- Plain CREATE INDEX, not CONCURRENTLY: the migrator runs each migration in a transaction, and at
-- a few thousand orders the build holds the orders write lock for milliseconds.
--
-- sales_goal is a new mutable table: the same auto-maintained updated_at as every other one
-- (set_updated_at() exists since migration 0001).
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "sales_goal" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint

-- The one row the Ringkasan target tracker reads (docs/plans/dashboard-overview.md §2.1, D3): the
-- Rp 1.000.000.000 first-year goal starting 1 November 2026, the v1 launch. Reference data the code
-- depends on, so it ships here and not only in seed.ts (CLAUDE.md). Idempotent; never overwrites a
-- value the owner has since edited on /settings.
INSERT INTO "sales_goal" ("id", "revenue_target_amount", "start_date") VALUES (1, 1000000000, '2026-11-01')
ON CONFLICT ("id") DO NOTHING;
