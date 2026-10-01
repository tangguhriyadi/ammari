-- Custom migration (drizzle-kit generate --custom): triggers cannot be expressed in Drizzle's
-- schema DSL, so this is hand-authored.

-- 1. Auto-maintain updated_at on every mutable table, so application code never has to
--    remember to set it.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER set_updated_at BEFORE UPDATE ON "roles" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "permissions" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "staff_users" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "fabrics" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "products" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "product_variants" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "production_batches" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "channels" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "orders" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "order_settlements" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "import_batches" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "ad_spend_daily" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "expenses" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "targets" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "cost_assumptions" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "customers" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "thank_you_cards" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "vouchers" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- 2. A system role (is_system = true) can never be deleted, and its is_system flag can never be
--    flipped off either — otherwise `UPDATE roles SET is_system = false ...` followed by a
--    plain DELETE would silently bypass the delete guard below. The "last active super_admin"
--    rule is enforced in application code (docs/SPEC.md §9) since it requires checking
--    staff_users.is_active, not just roles; these two triggers cover the unconditional part.
CREATE OR REPLACE FUNCTION prevent_system_role_delete()
RETURNS trigger AS $$
BEGIN
  IF OLD.is_system THEN
    RAISE EXCEPTION 'cannot delete system role "%"', OLD.key
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_system_role_delete BEFORE DELETE ON "roles" FOR EACH ROW EXECUTE FUNCTION prevent_system_role_delete();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_system_role_downgrade()
RETURNS trigger AS $$
BEGIN
  IF OLD.is_system AND NOT NEW.is_system THEN
    RAISE EXCEPTION 'cannot unset is_system on role "%"', OLD.key
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prevent_system_role_downgrade BEFORE UPDATE ON "roles" FOR EACH ROW EXECUTE FUNCTION prevent_system_role_downgrade();
