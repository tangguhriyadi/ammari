ALTER TABLE "production_batches" ADD COLUMN "reopened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN "reopened_by_staff_user_id" uuid;--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN "reopen_reason" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "reopened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "reopened_by_staff_user_id" uuid;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "reopen_reason" text;--> statement-breakpoint
-- Hand-moved above the composite FKs that reference them (drizzle-kit emitted these after the FKs,
-- which Postgres refuses: an FK target must already have a unique constraint). Same fix as 0026.
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_id_purchase_item_id_key" UNIQUE("id","purchase_item_id");--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_id_production_batch_item_id_key" UNIQUE("id","production_batch_item_id");--> statement-breakpoint
ALTER TABLE "defect_movements" ADD CONSTRAINT "defect_movements_receipt_item_purchase_item_fk" FOREIGN KEY ("goods_receipt_item_id","purchase_item_id") REFERENCES "public"."goods_receipt_items"("id","purchase_item_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "defect_movements" ADD CONSTRAINT "defect_movements_receipt_item_batch_item_fk" FOREIGN KEY ("goods_receipt_item_id","production_batch_item_id") REFERENCES "public"."goods_receipt_items"("id","production_batch_item_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_reopened_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("reopened_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_reopened_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("reopened_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "production_batches_reopened_by_staff_user_id_idx" ON "production_batches" USING btree ("reopened_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "purchases_reopened_by_staff_user_id_idx" ON "purchases" USING btree ("reopened_by_staff_user_id");--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_reopened_triple_check" CHECK (num_nonnulls("production_batches"."reopened_at", "production_batches"."reopened_by_staff_user_id", "production_batches"."reopen_reason") in (0, 3) and ("production_batches"."reopen_reason" is null or btrim("production_batches"."reopen_reason") <> ''));--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_reopened_triple_check" CHECK (num_nonnulls("purchases"."reopened_at", "purchases"."reopened_by_staff_user_id", "purchases"."reopen_reason") in (0, 3) and ("purchases"."reopen_reason" is null or btrim("purchases"."reopen_reason") <> ''));--> statement-breakpoint

-- Hand-authored below this line (same idiom as migrations 0004/0007/0008/0012/0022/0024/0025/0026):
-- docs/plans/suppliers-goods-receipt.md §3.2/§3.5/§5, session S6.
--
-- Backward compatibility with the previous release (CLAUDE.md expand/contract): everything here is
-- additive. The six re-open columns are nullable and nothing in the previous release names them;
-- their triple check passes trivially for all-NULL rows, so its closes/receipts stay valid (and a
-- re-opened document the previous release closes again simply keeps its re-open stamp). The two new
-- composite FKs only constrain rows with a goods_receipt_item_id (rejects and reject reversals),
-- which the previous release has always written against the receipt item of the SAME source line;
-- they are validated against existing rows when added, so a database that ever broke that rule
-- fails here loudly instead of carrying a silent mismatch. The new UNIQUE constraints are on
-- (pk, column) pairs and can never be violated. The trigger below only inspects NEW 'reversal'
-- rows; the previous release's only reversals (of rejects, via reverseRejectsInTx) are exact
-- copy-and-negate rows and pass it.
--
-- check_defect_reversal_matches: the guard S5 noted as missing (plan §5 S5 note (f)). A
-- 'reversal' row must be the exact copy-and-negation of the row it reverses: same item and source
-- line, same disposal_type, qty / value_amount / proceeds_amount exactly negated, and the reversed
-- row must not itself be a reversal. goods_receipt_item_id is deliberately NOT compared: a reject's
-- reversal points it at the REVERSAL receipt's item (S5 note (d)); the composite FKs above keep it
-- on the same source line. Insert-only, so it never re-checks history. Re-runnable: CREATE OR
-- REPLACE + DROP IF EXISTS.
CREATE OR REPLACE FUNCTION check_defect_reversal_matches()
RETURNS trigger AS $$
DECLARE
  original defect_movements%ROWTYPE;
BEGIN
  IF NEW.type <> 'reversal' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO original FROM defect_movements WHERE id = NEW.reverses_movement_id;
  IF NOT FOUND THEN
    -- The self-FK reports this with its own error; nothing to compare against here.
    RETURN NEW;
  END IF;
  IF original.type = 'reversal' THEN
    RAISE EXCEPTION 'a defect reversal cannot itself be reversed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.item_kind IS DISTINCT FROM original.item_kind
     OR NEW.sku IS DISTINCT FROM original.sku
     OR NEW.fabric_id IS DISTINCT FROM original.fabric_id
     OR NEW.accessory_id IS DISTINCT FROM original.accessory_id
     OR NEW.purchase_item_id IS DISTINCT FROM original.purchase_item_id
     OR NEW.production_batch_item_id IS DISTINCT FROM original.production_batch_item_id
     OR NEW.disposal_type IS DISTINCT FROM original.disposal_type
     OR NEW.qty <> -original.qty
     OR NEW.value_amount <> -original.value_amount
     OR NEW.proceeds_amount IS DISTINCT FROM -original.proceeds_amount THEN
    RAISE EXCEPTION 'a defect reversal must be the exact negation of the row it reverses (same item, source line and disposal type; qty, value and proceeds negated)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS check_defect_reversal_matches ON "defect_movements";--> statement-breakpoint

CREATE TRIGGER check_defect_reversal_matches BEFORE INSERT ON "defect_movements"
  FOR EACH ROW EXECUTE FUNCTION check_defect_reversal_matches();
