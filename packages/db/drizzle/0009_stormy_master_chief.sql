-- IF NOT EXISTS (not plain CREATE INDEX, which is what drizzle-kit generated here): these 4
-- indexes are byte-for-byte the same ones migration 0008 ALSO created, by hand, in its own
-- hand-authored section — a migration-tooling drift bug (0008 was hand-edited to add them after
-- its own snapshot was committed, so a later `drizzle-kit generate` run, producing this file,
-- never saw them and "discovered" them as missing again). Discovered when freshly migrating
-- `ammari_e2e` from scratch: 0008 creates them, then this file's original plain CREATE INDEX
-- failed with "already exists". IF NOT EXISTS makes this file safe to run fresh (e2e, a new
-- clone) AND unchanged for any environment where 0009 already ran unmodified.
CREATE INDEX IF NOT EXISTS "accessory_movements_created_by_staff_user_id_idx" ON "accessory_movements" USING btree ("created_by_staff_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accessory_movements_voided_by_staff_user_id_idx" ON "accessory_movements" USING btree ("voided_by_staff_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fabric_stock_movements_created_by_staff_user_id_idx" ON "fabric_stock_movements" USING btree ("created_by_staff_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fabric_stock_movements_voided_by_staff_user_id_idx" ON "fabric_stock_movements" USING btree ("voided_by_staff_user_id");