ALTER TABLE "cost_components" ADD COLUMN "cost_type" text DEFAULT 'variable' NOT NULL;--> statement-breakpoint

-- production_batch_costs.cost_type has no default (always set explicitly at insert from here
-- on — see that column's doc comment in catalog.ts) but this table is not empty in general (a
-- real deploy, or a locally seeded db, may already have rows) — added nullable, backfilled from
-- each row's own cost_component's CURRENT cost_type (the only value we have for pre-existing
-- rows; a snapshot column can't retroactively know what the type was at original insert time,
-- same unavoidable gap as any snapshot column added after the fact), then made NOT NULL.
ALTER TABLE "production_batch_costs" ADD COLUMN "cost_type" text;--> statement-breakpoint

-- prevent_posted_batch_cost_mutation (migration 0007) rejects ANY update to a posted batch's
-- cost lines, including this backfill — disabled for this one statement only, same
-- trigger-disable-then-reenable idiom packages/db/test/helpers.ts's withTriggerDisabled uses for
-- disposable test fixtures, but here for a real, one-time schema backfill. Never a general
-- loosening of the trigger: it's re-enabled immediately after, in the same migration.
ALTER TABLE "production_batch_costs" DISABLE TRIGGER "prevent_posted_batch_cost_mutation";--> statement-breakpoint

UPDATE "production_batch_costs"
SET "cost_type" = "cost_components"."cost_type"
FROM "cost_components"
WHERE "cost_components"."id" = "production_batch_costs"."cost_component_id";--> statement-breakpoint

ALTER TABLE "production_batch_costs" ENABLE TRIGGER "prevent_posted_batch_cost_mutation";--> statement-breakpoint

ALTER TABLE "production_batch_costs" ALTER COLUMN "cost_type" SET NOT NULL;--> statement-breakpoint

CREATE INDEX "product_accessory_recipes_accessory_id_idx" ON "product_accessory_recipes" USING btree ("accessory_id");--> statement-breakpoint
CREATE INDEX "production_batch_accessory_overrides_accessory_id_idx" ON "production_batch_accessory_overrides" USING btree ("accessory_id");--> statement-breakpoint
ALTER TABLE "cost_components" ADD CONSTRAINT "cost_components_cost_type_check" CHECK ("cost_components"."cost_type" in ('variable', 'fixed'));--> statement-breakpoint
ALTER TABLE "production_batch_costs" ADD CONSTRAINT "production_batch_costs_cost_type_check" CHECK ("production_batch_costs"."cost_type" in ('variable', 'fixed'));