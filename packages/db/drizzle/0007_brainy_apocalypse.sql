CREATE TABLE "cost_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" "citext" NOT NULL,
	"unit" text NOT NULL,
	"default_unit_price" bigint,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_components_name_unique" UNIQUE("name"),
	CONSTRAINT "cost_components_unit_check" CHECK ("cost_components"."unit" in ('pcs', 'meter', 'yard', 'lusin', 'set')),
	CONSTRAINT "cost_components_default_unit_price_check" CHECK ("cost_components"."default_unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "production_batch_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_batch_id" uuid NOT NULL,
	"cost_component_id" uuid NOT NULL,
	"component_name" text NOT NULL,
	"component_unit" text NOT NULL,
	"quantity" numeric(10, 2) NOT NULL,
	"unit_price" bigint NOT NULL,
	"total" bigint GENERATED ALWAYS AS (round(quantity * unit_price)) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_batch_costs_quantity_check" CHECK ("production_batch_costs"."quantity" > 0),
	CONSTRAINT "production_batch_costs_unit_price_check" CHECK ("production_batch_costs"."unit_price" >= 0),
	CONSTRAINT "production_batch_costs_component_unit_check" CHECK ("production_batch_costs"."component_unit" in ('pcs', 'meter', 'yard', 'lusin', 'set'))
);
--> statement-breakpoint
ALTER TABLE "production_batches" DROP CONSTRAINT "production_batches_roll_count_check";--> statement-breakpoint
ALTER TABLE "production_batches" DROP CONSTRAINT "production_batches_sewing_cost_amount_check";--> statement-breakpoint
ALTER TABLE "production_batches" DROP CONSTRAINT "production_batches_other_cost_amount_check";--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN "fabric_yards" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "production_batch_costs" ADD CONSTRAINT "production_batch_costs_production_batch_id_production_batches_id_fk" FOREIGN KEY ("production_batch_id") REFERENCES "public"."production_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batch_costs" ADD CONSTRAINT "production_batch_costs_cost_component_id_cost_components_id_fk" FOREIGN KEY ("cost_component_id") REFERENCES "public"."cost_components"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "production_batch_costs_production_batch_id_idx" ON "production_batch_costs" USING btree ("production_batch_id");--> statement-breakpoint
CREATE INDEX "production_batch_costs_cost_component_id_idx" ON "production_batch_costs" USING btree ("cost_component_id");--> statement-breakpoint
ALTER TABLE "production_batches" DROP COLUMN "roll_count";--> statement-breakpoint
ALTER TABLE "production_batches" DROP COLUMN "sewing_cost_amount";--> statement-breakpoint
ALTER TABLE "production_batches" DROP COLUMN "other_cost_amount";--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_fabric_yards_check" CHECK ("production_batches"."fabric_yards" is null or "production_batches"."fabric_yards" > 0);--> statement-breakpoint

-- Three DB-level immutability guards (not just app code) for a posted batch. Same hand-authored
-- trigger technique as enforce_variant_size_mode (migration 0004). The child-table triggers
-- below use COALESCE(NEW.production_batch_id, OLD.production_batch_id) so one function covers
-- INSERT (OLD is null), UPDATE, and DELETE (NEW is null) alike.

-- 1. production_batches itself: once posted, fabric_yards/fabric_cost_amount/fabric_id can never
-- change again. The WHEN clause only looks at OLD.status, so the draft -> posted transition
-- itself (OLD.status = 'draft') is never blocked — only a row that is ALREADY posted is frozen.
CREATE OR REPLACE FUNCTION prevent_posted_batch_field_change()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cannot change fabric_yards, fabric_cost_amount, or fabric_id of a posted production batch'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_posted_batch_field_change BEFORE UPDATE ON "production_batches" FOR EACH ROW
  WHEN (
    OLD.status = 'posted' AND (
      NEW.fabric_yards IS DISTINCT FROM OLD.fabric_yards OR
      NEW.fabric_cost_amount IS DISTINCT FROM OLD.fabric_cost_amount OR
      NEW.fabric_id IS DISTINCT FROM OLD.fabric_id
    )
  )
  EXECUTE FUNCTION prevent_posted_batch_field_change();
--> statement-breakpoint

-- 1b. production_batches itself, DELETE: the UPDATE guard above only froze 3 fields, leaving the
-- whole row deletable (and its items/costs cascading away) with no DB-level resistance — only
-- deleteDraft's app-level status check stood in the way. A posted batch is a permanent financial
-- record (HPP/stock history), so deletion is blocked unconditionally once posted, same as the
-- field-change guard; the test DB's own cleanup helpers for a temporarily-posted fixture must
-- disable this trigger first (see queries.test.ts's forceDeletePostedBatchFixture).
CREATE OR REPLACE FUNCTION prevent_posted_batch_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cannot delete a posted production batch' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_posted_batch_delete BEFORE DELETE ON "production_batches" FOR EACH ROW
  WHEN (OLD.status = 'posted')
  EXECUTE FUNCTION prevent_posted_batch_delete();
--> statement-breakpoint

-- 2. production_batch_items — retrofitting the same guarantee production_batch_costs gets below
-- (previously this table relied ONLY on app-level checks in updateDraft/deleteDraft/postBatch).
-- NOTE: this trigger's own SELECT status lookup is unlocked (no FOR SHARE/FOR UPDATE) — it
-- correctly rejects any write attempted AFTER a posting transaction has already committed (the
-- main threat model, and what the test suite exercises), but it is not an independent
-- concurrency guarantee during a true race. That guarantee still depends on every write path
-- locking the parent row FIRST via lockProductionBatchForUpdate, exactly as updateDraft/postBatch
-- already do (same "lock first, trigger is a second independent backstop" pattern documented on
-- stockMovements in catalog.ts) — a future write path that skips that lock would not be caught
-- here during the race window itself, only once 'posted' is actually committed.
CREATE OR REPLACE FUNCTION prevent_posted_batch_items_mutation()
RETURNS trigger AS $$
DECLARE
  batch_status text;
BEGIN
  SELECT status INTO batch_status FROM "production_batches"
    WHERE id = COALESCE(NEW.production_batch_id, OLD.production_batch_id);
  IF batch_status = 'posted' THEN
    RAISE EXCEPTION 'cannot modify lines of a posted production batch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_posted_batch_items_mutation BEFORE INSERT OR UPDATE OR DELETE ON "production_batch_items"
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_batch_items_mutation();
--> statement-breakpoint

-- 3. production_batch_costs — the new table's own posted-batch guard (requirement #3 of this
-- migration's feature: "immutable after posting (enforce in the DB, not only the UI)").
CREATE OR REPLACE FUNCTION prevent_posted_batch_cost_mutation()
RETURNS trigger AS $$
DECLARE
  batch_status text;
BEGIN
  SELECT status INTO batch_status FROM "production_batches"
    WHERE id = COALESCE(NEW.production_batch_id, OLD.production_batch_id);
  IF batch_status = 'posted' THEN
    RAISE EXCEPTION 'cannot modify cost lines of a posted production batch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_posted_batch_cost_mutation BEFORE INSERT OR UPDATE OR DELETE ON "production_batch_costs"
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_batch_cost_mutation();
--> statement-breakpoint

-- cost_components is a new mutable table — same auto-maintained updated_at every other mutable
-- table has (set_updated_at() already exists, from migration 0001).
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "cost_components" FOR EACH ROW EXECUTE FUNCTION set_updated_at();