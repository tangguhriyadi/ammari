CREATE TABLE "defect_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_kind" text NOT NULL,
	"sku" text,
	"fabric_id" uuid,
	"accessory_id" uuid,
	"type" text NOT NULL,
	"qty" numeric(10, 2) NOT NULL,
	"value_amount" bigint NOT NULL,
	"goods_receipt_item_id" uuid,
	"purchase_item_id" uuid,
	"production_batch_item_id" uuid,
	"disposal_type" text,
	"proceeds_amount" bigint,
	"occurred_at" date NOT NULL,
	"reverses_movement_id" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by_staff_user_id" uuid,
	"note" text,
	"created_by_staff_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "defect_movements_reverses_movement_id_key" UNIQUE("reverses_movement_id"),
	CONSTRAINT "defect_movements_item_kind_check" CHECK ("defect_movements"."item_kind" in ('sku', 'fabric', 'accessory')),
	CONSTRAINT "defect_movements_exactly_one_item_check" CHECK (num_nonnulls("defect_movements"."sku", "defect_movements"."fabric_id", "defect_movements"."accessory_id") = 1 and ("defect_movements"."item_kind" = 'sku') = ("defect_movements"."sku" is not null) and ("defect_movements"."item_kind" = 'fabric') = ("defect_movements"."fabric_id" is not null) and ("defect_movements"."item_kind" = 'accessory') = ("defect_movements"."accessory_id" is not null)),
	CONSTRAINT "defect_movements_exactly_one_source_check" CHECK (("defect_movements"."purchase_item_id" is null) <> ("defect_movements"."production_batch_item_id" is null) and ("defect_movements"."item_kind" = 'sku') = ("defect_movements"."production_batch_item_id" is not null)),
	CONSTRAINT "defect_movements_type_check" CHECK ("defect_movements"."type" in ('reject', 'return_out', 'dispose', 'reversal')),
	CONSTRAINT "defect_movements_qty_nonzero_check" CHECK ("defect_movements"."qty" <> 0),
	CONSTRAINT "defect_movements_reject_qty_check" CHECK ("defect_movements"."type" <> 'reject' or "defect_movements"."qty" > 0),
	CONSTRAINT "defect_movements_outflow_qty_check" CHECK ("defect_movements"."type" not in ('return_out', 'dispose') or "defect_movements"."qty" < 0),
	CONSTRAINT "defect_movements_whole_qty_check" CHECK ("defect_movements"."item_kind" = 'fabric' or "defect_movements"."qty" = round("defect_movements"."qty")),
	CONSTRAINT "defect_movements_reject_receipt_item_check" CHECK ("defect_movements"."type" <> 'reject' or "defect_movements"."goods_receipt_item_id" is not null),
	CONSTRAINT "defect_movements_disposal_type_check" CHECK ("defect_movements"."disposal_type" in ('auction', 'donation', 'discarded')),
	CONSTRAINT "defect_movements_disposal_type_movement_check" CHECK ("defect_movements"."disposal_type" is null or "defect_movements"."type" in ('dispose', 'reversal')),
	CONSTRAINT "defect_movements_dispose_has_type_check" CHECK ("defect_movements"."type" <> 'dispose' or "defect_movements"."disposal_type" is not null),
	CONSTRAINT "defect_movements_proceeds_pair_check" CHECK (("defect_movements"."disposal_type" is null) = ("defect_movements"."proceeds_amount" is null)),
	CONSTRAINT "defect_movements_auction_proceeds_check" CHECK ("defect_movements"."type" <> 'dispose' or "defect_movements"."disposal_type" <> 'auction' or "defect_movements"."proceeds_amount" > 0),
	CONSTRAINT "defect_movements_zero_proceeds_check" CHECK ("defect_movements"."type" <> 'dispose' or "defect_movements"."disposal_type" not in ('donation', 'discarded') or "defect_movements"."proceeds_amount" = 0),
	CONSTRAINT "defect_movements_dispose_note_check" CHECK ("defect_movements"."type" <> 'dispose' or ("defect_movements"."note" is not null and btrim("defect_movements"."note") <> '')),
	CONSTRAINT "defect_movements_reverses_movement_id_pair_check" CHECK (("defect_movements"."type" = 'reversal') = ("defect_movements"."reverses_movement_id" is not null)),
	CONSTRAINT "defect_movements_reversed_pair_check" CHECK (("defect_movements"."reversed_at" is not null) = ("defect_movements"."reversed_by_staff_user_id" is not null)),
	CONSTRAINT "defect_movements_reversed_at_type_check" CHECK ("defect_movements"."reversed_at" is null or "defect_movements"."type" <> 'reversal')
);
--> statement-breakpoint
ALTER TABLE "goods_receipt_items" DROP CONSTRAINT "goods_receipt_items_qty_nonzero_check";--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD COLUMN "qty_rejected" numeric(10, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Hand-moved above the composite FKs that reference them (drizzle-kit emitted these after the FKs,
-- which Postgres refuses: an FK target must already have a unique constraint).
ALTER TABLE "production_batch_items" ADD CONSTRAINT "production_batch_items_id_sku_key" UNIQUE("id","sku");--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_id_fabric_id_key" UNIQUE("id","fabric_id");--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_id_accessory_id_key" UNIQUE("id","accessory_id");--> statement-breakpoint
ALTER TABLE "defect_movements" ADD CONSTRAINT "defect_movements_sku_product_variants_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."product_variants"("sku") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defect_movements" ADD CONSTRAINT "defect_movements_fabric_id_fabrics_id_fk" FOREIGN KEY ("fabric_id") REFERENCES "public"."fabrics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defect_movements" ADD CONSTRAINT "defect_movements_accessory_id_accessories_id_fk" FOREIGN KEY ("accessory_id") REFERENCES "public"."accessories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defect_movements" ADD CONSTRAINT "defect_movements_goods_receipt_item_id_goods_receipt_items_id_fk" FOREIGN KEY ("goods_receipt_item_id") REFERENCES "public"."goods_receipt_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defect_movements" ADD CONSTRAINT "defect_movements_reverses_movement_id_defect_movements_id_fk" FOREIGN KEY ("reverses_movement_id") REFERENCES "public"."defect_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defect_movements" ADD CONSTRAINT "defect_movements_reversed_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("reversed_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defect_movements" ADD CONSTRAINT "defect_movements_created_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defect_movements" ADD CONSTRAINT "defect_movements_purchase_item_fabric_fk" FOREIGN KEY ("purchase_item_id","fabric_id") REFERENCES "public"."purchase_items"("id","fabric_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "defect_movements" ADD CONSTRAINT "defect_movements_purchase_item_accessory_fk" FOREIGN KEY ("purchase_item_id","accessory_id") REFERENCES "public"."purchase_items"("id","accessory_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "defect_movements" ADD CONSTRAINT "defect_movements_production_batch_item_sku_fk" FOREIGN KEY ("production_batch_item_id","sku") REFERENCES "public"."production_batch_items"("id","sku") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "defect_movements_sku_created_at_idx" ON "defect_movements" USING btree ("sku","created_at");--> statement-breakpoint
CREATE INDEX "defect_movements_fabric_id_created_at_idx" ON "defect_movements" USING btree ("fabric_id","created_at");--> statement-breakpoint
CREATE INDEX "defect_movements_accessory_id_created_at_idx" ON "defect_movements" USING btree ("accessory_id","created_at");--> statement-breakpoint
CREATE INDEX "defect_movements_purchase_item_id_idx" ON "defect_movements" USING btree ("purchase_item_id");--> statement-breakpoint
CREATE INDEX "defect_movements_production_batch_item_id_idx" ON "defect_movements" USING btree ("production_batch_item_id");--> statement-breakpoint
CREATE INDEX "defect_movements_goods_receipt_item_id_idx" ON "defect_movements" USING btree ("goods_receipt_item_id");--> statement-breakpoint
CREATE INDEX "defect_movements_reversed_by_staff_user_id_idx" ON "defect_movements" USING btree ("reversed_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "defect_movements_created_by_staff_user_id_idx" ON "defect_movements" USING btree ("created_by_staff_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "defect_movements_reject_goods_receipt_item_unique_idx" ON "defect_movements" USING btree ("goods_receipt_item_id") WHERE "defect_movements"."type" = 'reject';--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_qty_rejected_sign_check" CHECK (("goods_receipt_items"."kind" = 'receipt' and "goods_receipt_items"."qty_rejected" >= 0) or ("goods_receipt_items"."kind" = 'reversal' and "goods_receipt_items"."qty_rejected" <= 0));--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_production_whole_rejected_check" CHECK ("goods_receipt_items"."source_type" <> 'production_batch' or "goods_receipt_items"."qty_rejected" = round("goods_receipt_items"."qty_rejected"));--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_qty_nonzero_check" CHECK ("goods_receipt_items"."qty_accepted" + "goods_receipt_items"."qty_rejected" <> 0);--> statement-breakpoint

-- Hand-authored below this line (same idiom as migrations 0004/0007/0008/0012/0022/0024/0025):
-- docs/plans/suppliers-goods-receipt.md §3.5, session S5.
--
-- Backward compatibility with the previous release (CLAUDE.md expand/contract): everything above
-- is additive. defect_movements is a new table nothing in the previous release reads or writes.
-- goods_receipt_items.qty_rejected is NOT NULL DEFAULT 0, so the previous release's receipt
-- inserts (which never name it) stay valid, and every existing row reads as "nothing rejected".
-- goods_receipt_items_qty_nonzero_check is widened from `qty_accepted <> 0` to
-- `qty_accepted + qty_rejected <> 0`: with qty_rejected = 0 the two are identical, so every row the
-- previous release writes satisfies it. The two new qty_rejected CHECKs pass trivially at 0. The
-- three new UNIQUE constraints are on (pk, column) pairs and so can never be violated.
--
-- prevent_defect_movement_mutation: a copy of prevent_accessory_movement_mutation (migration
-- 0008). defect_movements is append-only: DELETE is always rejected; UPDATE is rejected unless the
-- only columns changing are reversed_at/reversed_by_staff_user_id, going from NULL, exactly once
-- (the reversal stamp on the original row, D8). Re-runnable: CREATE OR REPLACE + DROP IF EXISTS.
CREATE OR REPLACE FUNCTION prevent_defect_movement_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'defect_movements is append-only; this row cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'this defect movement has already been reversed' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'reversed_at' - 'reversed_by_staff_user_id') IS DISTINCT FROM (to_jsonb(OLD) - 'reversed_at' - 'reversed_by_staff_user_id') THEN
    RAISE EXCEPTION 'defect_movements rows are append-only except for stamping a reversal (reversed_at/reversed_by_staff_user_id only)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS prevent_defect_movement_mutation ON "defect_movements";--> statement-breakpoint

CREATE TRIGGER prevent_defect_movement_mutation BEFORE UPDATE OR DELETE ON "defect_movements"
  FOR EACH ROW EXECUTE FUNCTION prevent_defect_movement_mutation();
