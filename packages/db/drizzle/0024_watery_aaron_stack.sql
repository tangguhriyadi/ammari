CREATE TABLE "goods_receipt_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"kind" text NOT NULL,
	"purchase_item_id" uuid,
	"production_batch_item_id" uuid,
	"qty_accepted" numeric(10, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipt_items_source_type_check" CHECK ("goods_receipt_items"."source_type" in ('purchase', 'production_batch')),
	CONSTRAINT "goods_receipt_items_kind_check" CHECK ("goods_receipt_items"."kind" in ('receipt', 'reversal')),
	CONSTRAINT "goods_receipt_items_exactly_one_source_check" CHECK (("goods_receipt_items"."purchase_item_id" is null) <> ("goods_receipt_items"."production_batch_item_id" is null) and ("goods_receipt_items"."source_type" = 'purchase') = ("goods_receipt_items"."purchase_item_id" is not null)),
	CONSTRAINT "goods_receipt_items_qty_accepted_sign_check" CHECK (("goods_receipt_items"."kind" = 'receipt' and "goods_receipt_items"."qty_accepted" >= 0) or ("goods_receipt_items"."kind" = 'reversal' and "goods_receipt_items"."qty_accepted" <= 0)),
	CONSTRAINT "goods_receipt_items_qty_nonzero_check" CHECK ("goods_receipt_items"."qty_accepted" <> 0),
	CONSTRAINT "goods_receipt_items_production_whole_qty_check" CHECK ("goods_receipt_items"."source_type" <> 'production_batch' or "goods_receipt_items"."qty_accepted" = round("goods_receipt_items"."qty_accepted"))
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_no" text NOT NULL,
	"source_type" text NOT NULL,
	"purchase_id" uuid,
	"production_batch_id" uuid,
	"kind" text NOT NULL,
	"received_at" date NOT NULL,
	"received_by_name" text,
	"reverses_receipt_id" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by_staff_user_id" uuid,
	"note" text,
	"created_by_staff_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipts_receipt_no_unique" UNIQUE("receipt_no"),
	CONSTRAINT "goods_receipts_reverses_receipt_id_key" UNIQUE("reverses_receipt_id"),
	CONSTRAINT "goods_receipts_id_source_type_kind_key" UNIQUE("id","source_type","kind"),
	CONSTRAINT "goods_receipts_source_type_check" CHECK ("goods_receipts"."source_type" in ('purchase', 'production_batch')),
	CONSTRAINT "goods_receipts_kind_check" CHECK ("goods_receipts"."kind" in ('receipt', 'reversal')),
	CONSTRAINT "goods_receipts_exactly_one_source_check" CHECK (("goods_receipts"."purchase_id" is null) <> ("goods_receipts"."production_batch_id" is null) and ("goods_receipts"."source_type" = 'purchase') = ("goods_receipts"."purchase_id" is not null)),
	CONSTRAINT "goods_receipts_reverses_receipt_id_pair_check" CHECK (("goods_receipts"."kind" = 'reversal') = ("goods_receipts"."reverses_receipt_id" is not null)),
	CONSTRAINT "goods_receipts_reversed_pair_check" CHECK (("goods_receipts"."reversed_at" is not null) = ("goods_receipts"."reversed_by_staff_user_id" is not null)),
	CONSTRAINT "goods_receipts_reversed_at_kind_check" CHECK ("goods_receipts"."reversed_at" is null or "goods_receipts"."kind" = 'receipt')
);
--> statement-breakpoint
CREATE TABLE "purchase_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"fabric_id" uuid,
	"accessory_id" uuid,
	"qty_ordered" numeric(10, 2) NOT NULL,
	"total_amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_items_item_type_check" CHECK ("purchase_items"."item_type" in ('fabric', 'accessory')),
	CONSTRAINT "purchase_items_exactly_one_target_check" CHECK (("purchase_items"."fabric_id" is null) <> ("purchase_items"."accessory_id" is null) and ("purchase_items"."item_type" = 'fabric') = ("purchase_items"."fabric_id" is not null)),
	CONSTRAINT "purchase_items_qty_ordered_check" CHECK ("purchase_items"."qty_ordered" > 0),
	CONSTRAINT "purchase_items_accessory_whole_qty_check" CHECK ("purchase_items"."item_type" <> 'accessory' or "purchase_items"."qty_ordered" = round("purchase_items"."qty_ordered")),
	CONSTRAINT "purchase_items_total_amount_check" CHECK ("purchase_items"."total_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_no" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"ordered_at" date NOT NULL,
	"notes" text,
	"status" text DEFAULT 'ordered' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_staff_user_id" uuid,
	"close_reason" text,
	"created_by_staff_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchases_purchase_no_unique" UNIQUE("purchase_no"),
	CONSTRAINT "purchases_status_check" CHECK ("purchases"."status" in ('ordered', 'partially_received', 'received', 'closed', 'cancelled')),
	CONSTRAINT "purchases_closed_status_check" CHECK ("purchases"."status" not in ('closed', 'cancelled') or "purchases"."closed_at" is not null),
	CONSTRAINT "purchases_closed_pair_check" CHECK (("purchases"."closed_at" is not null) = ("purchases"."closed_by_staff_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "accessory_movements" DROP CONSTRAINT "accessory_movements_ref_type_check";--> statement-breakpoint
ALTER TABLE "fabric_stock_movements" DROP CONSTRAINT "fabric_stock_movements_ref_type_check";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_ref_type_check";--> statement-breakpoint
ALTER TABLE "accessory_movements" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "fabric_stock_movements" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_purchase_item_id_purchase_items_id_fk" FOREIGN KEY ("purchase_item_id") REFERENCES "public"."purchase_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_production_batch_item_id_production_batch_items_id_fk" FOREIGN KEY ("production_batch_item_id") REFERENCES "public"."production_batch_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_receipt_fk" FOREIGN KEY ("goods_receipt_id","source_type","kind") REFERENCES "public"."goods_receipts"("id","source_type","kind") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_production_batch_id_production_batches_id_fk" FOREIGN KEY ("production_batch_id") REFERENCES "public"."production_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_reverses_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("reverses_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_reversed_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("reversed_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_created_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_fabric_id_fabrics_id_fk" FOREIGN KEY ("fabric_id") REFERENCES "public"."fabrics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_accessory_id_accessories_id_fk" FOREIGN KEY ("accessory_id") REFERENCES "public"."accessories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_closed_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("closed_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_created_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goods_receipt_items_goods_receipt_id_idx" ON "goods_receipt_items" USING btree ("goods_receipt_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_items_purchase_item_id_idx" ON "goods_receipt_items" USING btree ("purchase_item_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_items_production_batch_item_id_idx" ON "goods_receipt_items" USING btree ("production_batch_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_items_receipt_purchase_item_key" ON "goods_receipt_items" USING btree ("goods_receipt_id","purchase_item_id") WHERE "goods_receipt_items"."purchase_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_items_receipt_batch_item_key" ON "goods_receipt_items" USING btree ("goods_receipt_id","production_batch_item_id") WHERE "goods_receipt_items"."production_batch_item_id" is not null;--> statement-breakpoint
CREATE INDEX "goods_receipts_purchase_id_created_at_idx" ON "goods_receipts" USING btree ("purchase_id","created_at");--> statement-breakpoint
CREATE INDEX "goods_receipts_production_batch_id_created_at_idx" ON "goods_receipts" USING btree ("production_batch_id","created_at");--> statement-breakpoint
CREATE INDEX "goods_receipts_received_at_idx" ON "goods_receipts" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "goods_receipts_reversed_by_staff_user_id_idx" ON "goods_receipts" USING btree ("reversed_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "goods_receipts_created_by_staff_user_id_idx" ON "goods_receipts" USING btree ("created_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "purchase_items_purchase_id_idx" ON "purchase_items" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "purchase_items_fabric_id_idx" ON "purchase_items" USING btree ("fabric_id");--> statement-breakpoint
CREATE INDEX "purchase_items_accessory_id_idx" ON "purchase_items" USING btree ("accessory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_items_purchase_id_fabric_id_key" ON "purchase_items" USING btree ("purchase_id","fabric_id") WHERE "purchase_items"."fabric_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_items_purchase_id_accessory_id_key" ON "purchase_items" USING btree ("purchase_id","accessory_id") WHERE "purchase_items"."accessory_id" is not null;--> statement-breakpoint
CREATE INDEX "purchases_supplier_id_idx" ON "purchases" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "purchases_status_idx" ON "purchases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "purchases_ordered_at_idx" ON "purchases" USING btree ("ordered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "purchases_closed_by_staff_user_id_idx" ON "purchases" USING btree ("closed_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "purchases_created_by_staff_user_id_idx" ON "purchases" USING btree ("created_by_staff_user_id");--> statement-breakpoint
ALTER TABLE "accessory_movements" ADD CONSTRAINT "accessory_movements_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fabric_stock_movements" ADD CONSTRAINT "fabric_stock_movements_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accessory_movements_supplier_id_idx" ON "accessory_movements" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accessory_movements_goods_receipt_ref_unique_idx" ON "accessory_movements" USING btree ("type","ref_type","ref_id") WHERE "accessory_movements"."ref_type" = 'goods_receipt';--> statement-breakpoint
CREATE INDEX "fabric_stock_movements_supplier_id_idx" ON "fabric_stock_movements" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fabric_stock_movements_goods_receipt_ref_unique_idx" ON "fabric_stock_movements" USING btree ("type","ref_type","ref_id") WHERE "fabric_stock_movements"."ref_type" = 'goods_receipt';--> statement-breakpoint
ALTER TABLE "accessory_movements" ADD CONSTRAINT "accessory_movements_ref_type_check" CHECK ("accessory_movements"."ref_type" in ('production_batch', 'manual', 'goods_receipt'));--> statement-breakpoint
ALTER TABLE "fabric_stock_movements" ADD CONSTRAINT "fabric_stock_movements_ref_type_check" CHECK ("fabric_stock_movements"."ref_type" in ('production_batch', 'manual', 'goods_receipt'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_ref_type_check" CHECK ("stock_movements"."ref_type" in ('production_batch_item', 'order_item', 'manual', 'goods_receipt_item'));--> statement-breakpoint

-- Hand-authored below this line (same idiom as migrations 0004/0007/0008/0012/0022): drizzle-kit
-- does not emit triggers or data. docs/plans/suppliers-goods-receipt.md session S3.
--
-- Backward compatibility with the previous release (CLAUDE.md expand/contract): everything above
-- is additive. New tables nothing old reads; two NULLABLE columns (supplier_id) on the
-- raw-material ledgers, which the previous release's purchase insert simply leaves NULL; and
-- three ref_type CHECKs whose new value list is a strict superset of the old one, so every
-- existing row and every row the previous release writes stays valid. The two new partial unique
-- indexes only cover ref_type = 'goods_receipt', a value the previous release never writes.

-- purchases is a mutable table — same auto-maintained updated_at as every other one
-- (set_updated_at() exists since migration 0001).
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "purchases" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- D7: once a purchase line has a non-reversed receipt item, its denominator (qty_ordered,
-- total_amount) and its item can no longer change, and the line can no longer be deleted —
-- editing them afterwards would retroactively re-price receipts already posted. Modelled on
-- prevent_posted_batch_field_change (migration 0007/0008): the UPDATE trigger's WHEN clause names
-- exactly the frozen columns, so the row-level EXISTS only runs when one of them actually changes.
-- A line whose every receipt has been reversed is free again (its net received quantity is 0).
-- App code refuses edits even earlier (any receipt at all, lib/purchases/queries.ts); this is the
-- backstop. Every DROP is IF EXISTS so this block stays re-runnable.
CREATE OR REPLACE FUNCTION prevent_received_purchase_item_change()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "goods_receipt_items" gri
    JOIN "goods_receipts" gr ON gr."id" = gri."goods_receipt_id"
    WHERE gri."purchase_item_id" = OLD."id"
      AND gr."kind" = 'receipt'
      AND gr."reversed_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot change or delete a purchase line that already has a receipt (qty_ordered, total_amount, item_type, fabric_id, accessory_id are frozen)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS prevent_received_purchase_item_change ON "purchase_items";--> statement-breakpoint

CREATE TRIGGER prevent_received_purchase_item_change BEFORE UPDATE ON "purchase_items" FOR EACH ROW
  WHEN (
    NEW.qty_ordered IS DISTINCT FROM OLD.qty_ordered OR
    NEW.total_amount IS DISTINCT FROM OLD.total_amount OR
    NEW.item_type IS DISTINCT FROM OLD.item_type OR
    NEW.fabric_id IS DISTINCT FROM OLD.fabric_id OR
    NEW.accessory_id IS DISTINCT FROM OLD.accessory_id
  )
  EXECUTE FUNCTION prevent_received_purchase_item_change();
--> statement-breakpoint

DROP TRIGGER IF EXISTS prevent_received_purchase_item_delete ON "purchase_items";--> statement-breakpoint

CREATE TRIGGER prevent_received_purchase_item_delete BEFORE DELETE ON "purchase_items" FOR EACH ROW
  EXECUTE FUNCTION prevent_received_purchase_item_change();
--> statement-breakpoint

-- D10: the new inventory.receive permission (post a goods receipt). Reference data the code
-- matches by literal key, so it ships here, not only in seed.ts (CLAUDE.md; same pattern as
-- migration 0012). Granted to super_admin and owner (it is not in
-- OWNER_EXCLUDED_PERMISSION_KEYS). Idempotent: ON CONFLICT DO NOTHING on both inserts.
INSERT INTO "permissions" ("key", "description", "group")
VALUES ('inventory.receive', 'Receive goods against purchase documents', 'inventory')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r, "permissions" p
WHERE r."key" IN ('super_admin', 'owner') AND p."key" = 'inventory.receive'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
