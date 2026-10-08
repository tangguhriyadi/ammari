CREATE TABLE "accessories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"size" text,
	"size_group" "citext",
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accessories_size_group_size_key" UNIQUE("size_group","size"),
	CONSTRAINT "accessories_size_check" CHECK ("accessories"."size" in ('XS', 'S', 'M', 'L', 'XL', 'ALLSIZE'))
);
--> statement-breakpoint
CREATE TABLE "accessory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accessory_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"value_amount" bigint NOT NULL,
	"type" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text,
	"reason" text,
	"supplier" text,
	"purchased_at" date,
	"voids_movement_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by_staff_user_id" uuid,
	"created_by_staff_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accessory_movements_voids_movement_id_key" UNIQUE("voids_movement_id"),
	CONSTRAINT "accessory_movements_qty_check" CHECK ("accessory_movements"."qty" <> 0),
	CONSTRAINT "accessory_movements_type_check" CHECK ("accessory_movements"."type" in ('purchase', 'purchase_void', 'production', 'adjustment')),
	CONSTRAINT "accessory_movements_ref_type_check" CHECK ("accessory_movements"."ref_type" in ('production_batch', 'manual')),
	CONSTRAINT "accessory_movements_reason_check" CHECK ("accessory_movements"."reason" in ('recount', 'damaged', 'lost', 'other')),
	CONSTRAINT "accessory_movements_reason_adjustment_pair_check" CHECK (("accessory_movements"."type" = 'adjustment') = ("accessory_movements"."reason" is not null)),
	CONSTRAINT "accessory_movements_purchased_at_pair_check" CHECK (("accessory_movements"."type" = 'purchase') = ("accessory_movements"."purchased_at" is not null)),
	CONSTRAINT "accessory_movements_voids_movement_id_pair_check" CHECK (("accessory_movements"."type" = 'purchase_void') = ("accessory_movements"."voids_movement_id" is not null)),
	CONSTRAINT "accessory_movements_voided_at_type_check" CHECK ("accessory_movements"."voided_at" is null or "accessory_movements"."type" = 'purchase'),
	CONSTRAINT "accessory_movements_voided_pair_check" CHECK (("accessory_movements"."voided_at" is not null) = ("accessory_movements"."voided_by_staff_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "fabric_stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fabric_id" uuid NOT NULL,
	"qty" numeric(10, 2) NOT NULL,
	"value_amount" bigint NOT NULL,
	"type" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text,
	"reason" text,
	"supplier" text,
	"purchased_at" date,
	"voids_movement_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by_staff_user_id" uuid,
	"created_by_staff_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fabric_stock_movements_voids_movement_id_key" UNIQUE("voids_movement_id"),
	CONSTRAINT "fabric_stock_movements_qty_check" CHECK ("fabric_stock_movements"."qty" <> 0),
	CONSTRAINT "fabric_stock_movements_type_check" CHECK ("fabric_stock_movements"."type" in ('purchase', 'purchase_void', 'production', 'adjustment')),
	CONSTRAINT "fabric_stock_movements_ref_type_check" CHECK ("fabric_stock_movements"."ref_type" in ('production_batch', 'manual')),
	CONSTRAINT "fabric_stock_movements_reason_check" CHECK ("fabric_stock_movements"."reason" in ('recount', 'damaged', 'lost', 'other')),
	CONSTRAINT "fabric_stock_movements_reason_adjustment_pair_check" CHECK (("fabric_stock_movements"."type" = 'adjustment') = ("fabric_stock_movements"."reason" is not null)),
	CONSTRAINT "fabric_stock_movements_purchased_at_pair_check" CHECK (("fabric_stock_movements"."type" = 'purchase') = ("fabric_stock_movements"."purchased_at" is not null)),
	CONSTRAINT "fabric_stock_movements_voids_movement_id_pair_check" CHECK (("fabric_stock_movements"."type" = 'purchase_void') = ("fabric_stock_movements"."voids_movement_id" is not null)),
	CONSTRAINT "fabric_stock_movements_voided_at_type_check" CHECK ("fabric_stock_movements"."voided_at" is null or "fabric_stock_movements"."type" = 'purchase'),
	CONSTRAINT "fabric_stock_movements_voided_pair_check" CHECK (("fabric_stock_movements"."voided_at" is not null) = ("fabric_stock_movements"."voided_by_staff_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "product_accessory_recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"accessory_id" uuid,
	"size_group" "citext",
	"qty_per_pcs" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_accessory_recipes_exactly_one_target_check" CHECK (("product_accessory_recipes"."accessory_id" is null) <> ("product_accessory_recipes"."size_group" is null)),
	CONSTRAINT "product_accessory_recipes_qty_per_pcs_check" CHECK ("product_accessory_recipes"."qty_per_pcs" > 0)
);
--> statement-breakpoint
CREATE TABLE "production_batch_accessory_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_batch_id" uuid NOT NULL,
	"accessory_id" uuid NOT NULL,
	"override_qty" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_batch_accessory_overrides_batch_accessory_key" UNIQUE("production_batch_id","accessory_id"),
	CONSTRAINT "production_batch_accessory_overrides_override_qty_check" CHECK ("production_batch_accessory_overrides"."override_qty" >= 0)
);
--> statement-breakpoint
ALTER TABLE "accessory_movements" ADD CONSTRAINT "accessory_movements_accessory_id_accessories_id_fk" FOREIGN KEY ("accessory_id") REFERENCES "public"."accessories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accessory_movements" ADD CONSTRAINT "accessory_movements_voids_movement_id_accessory_movements_id_fk" FOREIGN KEY ("voids_movement_id") REFERENCES "public"."accessory_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accessory_movements" ADD CONSTRAINT "accessory_movements_voided_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("voided_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accessory_movements" ADD CONSTRAINT "accessory_movements_created_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fabric_stock_movements" ADD CONSTRAINT "fabric_stock_movements_fabric_id_fabrics_id_fk" FOREIGN KEY ("fabric_id") REFERENCES "public"."fabrics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fabric_stock_movements" ADD CONSTRAINT "fabric_stock_movements_voids_movement_id_fabric_stock_movements_id_fk" FOREIGN KEY ("voids_movement_id") REFERENCES "public"."fabric_stock_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fabric_stock_movements" ADD CONSTRAINT "fabric_stock_movements_voided_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("voided_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fabric_stock_movements" ADD CONSTRAINT "fabric_stock_movements_created_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_accessory_recipes" ADD CONSTRAINT "product_accessory_recipes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_accessory_recipes" ADD CONSTRAINT "product_accessory_recipes_accessory_id_accessories_id_fk" FOREIGN KEY ("accessory_id") REFERENCES "public"."accessories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batch_accessory_overrides" ADD CONSTRAINT "production_batch_accessory_overrides_production_batch_id_production_batches_id_fk" FOREIGN KEY ("production_batch_id") REFERENCES "public"."production_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batch_accessory_overrides" ADD CONSTRAINT "production_batch_accessory_overrides_accessory_id_accessories_id_fk" FOREIGN KEY ("accessory_id") REFERENCES "public"."accessories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accessory_movements_accessory_id_created_at_idx" ON "accessory_movements" USING btree ("accessory_id","created_at");--> statement-breakpoint
CREATE INDEX "accessory_movements_ref_idx" ON "accessory_movements" USING btree ("ref_type","ref_id");--> statement-breakpoint
-- Both are RESTRICT FKs to staff_users on an append-only, only-grows table — same reasoning
-- stock_movements_created_by_staff_user_id_idx already gives for its own sibling column
-- (database-reviewer finding).
CREATE INDEX "accessory_movements_created_by_staff_user_id_idx" ON "accessory_movements" USING btree ("created_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "accessory_movements_voided_by_staff_user_id_idx" ON "accessory_movements" USING btree ("voided_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "fabric_stock_movements_fabric_id_created_at_idx" ON "fabric_stock_movements" USING btree ("fabric_id","created_at");--> statement-breakpoint
CREATE INDEX "fabric_stock_movements_ref_idx" ON "fabric_stock_movements" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "fabric_stock_movements_created_by_staff_user_id_idx" ON "fabric_stock_movements" USING btree ("created_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "fabric_stock_movements_voided_by_staff_user_id_idx" ON "fabric_stock_movements" USING btree ("voided_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "product_accessory_recipes_product_id_idx" ON "product_accessory_recipes" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_accessory_recipes_product_id_accessory_id_key" ON "product_accessory_recipes" USING btree ("product_id","accessory_id") WHERE "product_accessory_recipes"."accessory_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_accessory_recipes_product_id_size_group_key" ON "product_accessory_recipes" USING btree ("product_id","size_group") WHERE "product_accessory_recipes"."size_group" is not null;
-- NOTE: drizzle-kit's diff also proposed `CREATE INDEX production_batch_costs_cost_component_id_idx`
-- here — that index already exists in every local database (applied by hand via psql during the
-- migration-0007 review-fix pass, outside migration tracking, so 0007's recorded snapshot never
-- caught up to it). Deliberately omitted; it is not new.
--> statement-breakpoint

-- Requirement 8: extend the existing posted-batch field-change guard (migration 0007) to also
-- reject changing `status` AWAY from 'posted' — only the 3 fabric fields were frozen before. A
-- trigger's WHEN clause can't be ALTERed in place, so this is DROP + CREATE of the same trigger,
-- reusing the same function name (CREATE OR REPLACE). The draft -> posted transition itself
-- (OLD.status = 'draft') is still never blocked — the WHEN clause only looks at OLD.status =
-- 'posted'. Every DROP TRIGGER below is IF EXISTS so this whole block stays safely re-runnable.
DROP TRIGGER IF EXISTS prevent_posted_batch_field_change ON "production_batches";--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_posted_batch_field_change()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cannot change the status or frozen fields (fabric_yards, fabric_cost_amount, fabric_id) of a posted production batch'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_posted_batch_field_change BEFORE UPDATE ON "production_batches" FOR EACH ROW
  WHEN (
    OLD.status = 'posted' AND (
      NEW.status IS DISTINCT FROM OLD.status OR
      NEW.fabric_yards IS DISTINCT FROM OLD.fabric_yards OR
      NEW.fabric_cost_amount IS DISTINCT FROM OLD.fabric_cost_amount OR
      NEW.fabric_id IS DISTINCT FROM OLD.fabric_id
    )
  )
  EXECUTE FUNCTION prevent_posted_batch_field_change();
--> statement-breakpoint

-- Correction #3 (binding, approved plan): every stock ledger becomes append-only at the DB
-- level, not just by convention — these become the source for accounting/audit later.

-- stock_movements: unconditionally immutable, no exceptions at all — finished-goods movements
-- are never corrected in place, only ever offset by a NEW adjustment row.
DROP TRIGGER IF EXISTS prevent_stock_movement_mutation ON "stock_movements";--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_stock_movement_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only; this row cannot be changed or deleted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_stock_movement_mutation BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION prevent_stock_movement_mutation();
--> statement-breakpoint

-- accessory_movements: DELETE always rejected. UPDATE rejected UNLESS the only columns changing
-- are voided_at/voided_by_staff_user_id, going from NULL, exactly once (OLD.voided_at already
-- set rejects any further update, including an identical no-op one — this doubles as the
-- double-void guard alongside the app-level check and the voids_movement_id unique constraint).
-- `to_jsonb(row) - 'col'` strips a key before comparing, so any OTHER column changing is caught
-- regardless of whether voided_at/voided_by_staff_user_id also changed in the same statement.
DROP TRIGGER IF EXISTS prevent_accessory_movement_mutation ON "accessory_movements";--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_accessory_movement_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accessory_movements is append-only; this row cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'this purchase has already been voided' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'voided_at' - 'voided_by_staff_user_id') IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'voided_by_staff_user_id') THEN
    RAISE EXCEPTION 'accessory_movements rows are append-only except for voiding a purchase (voided_at/voided_by_staff_user_id only)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_accessory_movement_mutation BEFORE UPDATE OR DELETE ON "accessory_movements"
  FOR EACH ROW EXECUTE FUNCTION prevent_accessory_movement_mutation();
--> statement-breakpoint

-- fabric_stock_movements: identical rule, same reasoning, separate function (mirrors
-- production_batch_items/production_batch_costs each getting their own near-duplicate trigger
-- function in migration 0007 rather than one shared generic one).
DROP TRIGGER IF EXISTS prevent_fabric_stock_movement_mutation ON "fabric_stock_movements";--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_fabric_stock_movement_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fabric_stock_movements is append-only; this row cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'this purchase has already been voided' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'voided_at' - 'voided_by_staff_user_id') IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'voided_by_staff_user_id') THEN
    RAISE EXCEPTION 'fabric_stock_movements rows are append-only except for voiding a purchase (voided_at/voided_by_staff_user_id only)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_fabric_stock_movement_mutation BEFORE UPDATE OR DELETE ON "fabric_stock_movements"
  FOR EACH ROW EXECUTE FUNCTION prevent_fabric_stock_movement_mutation();
--> statement-breakpoint

-- Requirement 6: cost_components becomes services-only — accessories now track their own stock
-- and moving-average cost via accessory_movements instead. Deactivate (never delete) a seeded
-- "goods" component still referenced by a historical production_batch_costs row; hard-delete
-- the rest, since removing an unreferenced row rewrites no history. Declarative and idempotent
-- (safe to run whether or not these rows exist, and regardless of which case applies to which
-- one) — no procedural block needed. "Ongkos jahit" (a service) is untouched either way.
DELETE FROM cost_components
WHERE name IN ('Kancing', 'Handtag', 'Plat metal brand', 'Zipper packaging')
  AND NOT EXISTS (
    SELECT 1 FROM production_batch_costs WHERE production_batch_costs.cost_component_id = cost_components.id
  );
--> statement-breakpoint

UPDATE cost_components
SET is_active = false
WHERE name IN ('Kancing', 'Handtag', 'Plat metal brand', 'Zipper packaging')
  AND EXISTS (
    SELECT 1 FROM production_batch_costs WHERE production_batch_costs.cost_component_id = cost_components.id
  );