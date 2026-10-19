ALTER TABLE "cost_components" ADD COLUMN "default_supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "production_batch_costs" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "production_batch_costs" ADD COLUMN "supplier_name" text;--> statement-breakpoint
ALTER TABLE "cost_components" ADD CONSTRAINT "cost_components_default_supplier_id_suppliers_id_fk" FOREIGN KEY ("default_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batch_costs" ADD CONSTRAINT "production_batch_costs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_components_default_supplier_id_idx" ON "cost_components" USING btree ("default_supplier_id");--> statement-breakpoint
CREATE INDEX "production_batch_costs_supplier_id_idx" ON "production_batch_costs" USING btree ("supplier_id");--> statement-breakpoint
ALTER TABLE "production_batch_costs" ADD CONSTRAINT "production_batch_costs_supplier_pair_check" CHECK (("production_batch_costs"."supplier_id" is null) = ("production_batch_costs"."supplier_name" is null));