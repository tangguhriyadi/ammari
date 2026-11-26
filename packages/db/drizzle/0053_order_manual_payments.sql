-- Migration 0053: Akuntansi Session 6, Feature D-3 (docs/plans/accounting.md §4.1 S6, §8 Session 6):
-- how each manual order (WhatsApp, Instagram, offline, manual web; never a checkout or marketplace
-- order) was paid and into which Kas & Bank account the money went. EXPAND-ONLY: one new table,
-- plus two refusals in accounts_guard_update that concern only that table (an account unposted
-- manual-order payments point at stays postable). The previous release neither reads nor writes it, so rollback stays
-- safe (orders created by it simply have no row: a posting issue for S6, filled later through
-- "Isi cara bayar").
-- drizzle-kit's statements first, then hand-authored (drizzle-kit emits no triggers).
CREATE TABLE "order_manual_payments" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"method" text NOT NULL,
	"cash_account_code" text NOT NULL,
	"paid_on" date NOT NULL,
	"recorded_by_staff_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_manual_payments_method_check" CHECK ("order_manual_payments"."method" in ('cash', 'transfer', 'card')),
	CONSTRAINT "order_manual_payments_cash_account_check" CHECK ("order_manual_payments"."cash_account_code" ~ '^1-1[12][0-9]{2}$')
);
--> statement-breakpoint
ALTER TABLE "order_manual_payments" ADD CONSTRAINT "order_manual_payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "order_manual_payments" ADD CONSTRAINT "order_manual_payments_cash_account_code_accounts_code_fk" FOREIGN KEY ("cash_account_code") REFERENCES "public"."accounts"("code") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "order_manual_payments" ADD CONSTRAINT "order_manual_payments_recorded_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("recorded_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_manual_payments_cash_account_code_idx" ON "order_manual_payments" USING btree ("cash_account_code");--> statement-breakpoint
CREATE INDEX "order_manual_payments_recorded_by_staff_user_id_idx" ON "order_manual_payments" USING btree ("recorded_by_staff_user_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Hand-authored from here.
-- ---------------------------------------------------------------------------------------------

-- ---- order_manual_payments: who may have a row, and where the money may go ----------------------
--   - only a manual order: payment_status IS NULL (not a web checkout order) and not a marketplace
--     channel (shopee/tiktok money lands in Saldo Penjual, D-11);
--   - only once its stock has left (a 'sale' movement exists, i.e. it reached "Siap Kirim"): a
--     manual order is always paid before it ships (D-3), and an order cancelled while still
--     waiting for payment never received money. The movement is append-only, so the check cannot
--     go stale;
--   - the account (on insert, and whenever it changes) is read FOR SHARE and must be active and
--     postable; FOR SHARE conflicts with accounts_guard_update's row lock, so a concurrent
--     deactivation waits for this insert or the insert sees it (same reasoning as
--     account_mappings_guard_target, 0049/0051). The Kas & Bank code range is a CHECK;
--   - order_id never changes.
CREATE OR REPLACE FUNCTION order_manual_payments_guard()
RETURNS trigger AS $$
DECLARE
  target accounts%ROWTYPE;
  ord record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'order_manual_payments: order_id is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_manual_payments_order', TABLE = 'order_manual_payments';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT o.channel_id, o.payment_status INTO ord FROM orders o WHERE o.id = NEW.order_id;
    -- An unknown order is left to the FK.
    IF FOUND THEN
      IF ord.payment_status IS NOT NULL OR ord.channel_id IN ('shopee', 'tiktok') THEN
        RAISE EXCEPTION 'order_manual_payments: order % is not a manual order (checkout or marketplace)', NEW.order_id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'order_manual_payments_order', TABLE = 'order_manual_payments';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM order_items oi
        JOIN stock_movements sm ON sm.ref_type = 'order_item' AND sm.ref_id = oi.id::text AND sm.type = 'sale'
        WHERE oi.order_id = NEW.order_id
      ) THEN
        RAISE EXCEPTION 'order_manual_payments: order % has not reached to_ship (no sale movement), so it was not paid yet', NEW.order_id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'order_manual_payments_order', TABLE = 'order_manual_payments';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.cash_account_code IS DISTINCT FROM OLD.cash_account_code THEN
    SELECT * INTO target FROM accounts WHERE code = NEW.cash_account_code FOR SHARE;
    -- An unknown account is left to the FK.
    IF FOUND AND (NOT target.is_active OR target.is_header) THEN
      RAISE EXCEPTION 'order_manual_payments: account % must be active and postable', NEW.cash_account_code
        USING ERRCODE = 'check_violation', CONSTRAINT = 'order_manual_payments_account', TABLE = 'order_manual_payments';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER order_manual_payments_guard BEFORE INSERT OR UPDATE ON "order_manual_payments" FOR EACH ROW
  EXECUTE FUNCTION order_manual_payments_guard();
--> statement-breakpoint

CREATE TRIGGER set_updated_at BEFORE UPDATE ON "order_manual_payments" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint

-- ---- order_manual_payments: no DELETE ------------------------------------------------------------
-- A record is corrected (UPDATE, audited), never removed: the app has no delete path, and a row that
-- vanished would leave its order silently unpostable (S6) with no audit trail.
CREATE OR REPLACE FUNCTION order_manual_payments_guard_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'order_manual_payments: a payment record is corrected, never deleted (order %)', OLD.order_id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'order_manual_payments_no_delete', TABLE = 'order_manual_payments';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER order_manual_payments_guard_delete BEFORE DELETE ON "order_manual_payments" FOR EACH ROW
  EXECUTE FUNCTION order_manual_payments_guard_delete();
--> statement-breakpoint

-- ---- accounts: identity, header, deactivation (0051's body, plus manual-order payments) -----------
-- An account manual-order payments point at must stay postable until rule S6 (Session 9) has posted
-- them, or every such order would fail to post:
--   - it never becomes a header (a header holds no lines);
--   - it is not deactivated while any of those payments has no active S6 journal (key
--     ('order', <order id>, 'collected'), plan §4.1). Once they are posted the account may be closed
--     like any other: old journals keep it (0050).
-- Race: order_manual_payments_guard reads the account FOR SHARE, which conflicts with this UPDATE's
-- row lock, so a payment insert and a deactivation run one after the other and each sees the other.
CREATE OR REPLACE FUNCTION accounts_guard_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.normal_balance IS DISTINCT FROM OLD.normal_balance OR NEW.is_system IS DISTINCT FROM OLD.is_system
     OR NEW.system_key IS DISTINCT FROM OLD.system_key THEN
    RAISE EXCEPTION 'accounts %: code, type, normal_balance, is_system and system_key are immutable', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.is_header AND NOT OLD.is_header
     AND EXISTS (SELECT 1 FROM journal_lines WHERE account_code = OLD.code OR cash_account_code = OLD.code) THEN
    RAISE EXCEPTION 'accounts %: an account with journal lines cannot become a header', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.is_header AND NOT OLD.is_header
     AND EXISTS (SELECT 1 FROM account_mappings WHERE account_code = OLD.code) THEN
    RAISE EXCEPTION 'accounts %: an account a mapping points at cannot become a header; re-map it first', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.is_active AND NOT NEW.is_active
     AND EXISTS (SELECT 1 FROM account_mappings WHERE account_code = OLD.code) THEN
    RAISE EXCEPTION 'accounts %: an account a mapping points at cannot be deactivated; re-map it first', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.is_header AND NOT OLD.is_header
     AND EXISTS (SELECT 1 FROM order_manual_payments WHERE cash_account_code = OLD.code) THEN
    RAISE EXCEPTION 'accounts %: an account manual-order payments point at cannot become a header', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.is_active AND NOT NEW.is_active
     AND EXISTS (
       SELECT 1 FROM order_manual_payments p
       WHERE p.cash_account_code = OLD.code
         AND NOT EXISTS (
           SELECT 1 FROM journal_entries je
           WHERE je.source_type = 'order' AND je.source_id = p.order_id::text AND je.source_event = 'collected'
             AND je.kind = 'system' AND je.reversed_by_entry_id IS NULL)) THEN
    RAISE EXCEPTION 'accounts %: manual-order payments not yet posted point at this account; it cannot be deactivated yet', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
