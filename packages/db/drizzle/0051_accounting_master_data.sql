-- Migration 0051: Akuntansi Session 3, Data Master Akun + Pemetaan akun (docs/plans/accounting.md
-- §8 Session 3 and the items §8.1 carries over from the Session 1 review). EXPAND-ONLY: two CHECKs
-- on accounts and three trigger functions replaced. No table or column is added, dropped or
-- renamed; the previous release never writes accounts or account_mappings (only seed.ts and this
-- session's editor do), and every row the earlier migrations inserted satisfies the new rules
-- (migration-0051.test.ts upgrades a 0050 database and re-checks them), so rollback stays safe.
-- drizzle-kit's statements first, then hand-authored (drizzle-kit emits no triggers).
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_code_type_check" CHECK ((left(code, 1) = '1' and type in ('asset')) or (left(code, 1) = '2' and type in ('liability')) or (left(code, 1) = '3' and type in ('equity')) or (left(code, 1) = '4' and type in ('revenue', 'contra_revenue')) or (left(code, 1) = '5' and type in ('cogs')) or (left(code, 1) = '6' and type in ('expense')) or (left(code, 1) = '7' and type in ('other_income')) or (left(code, 1) = '8' and type in ('other_expense')) or (left(code, 1) = '9' and type in ('tax')));--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_bank_fields_cash_bank_check" CHECK (("accounts"."bank_name" is null and "accounts"."account_no_last4" is null)
        or ("accounts"."code" ~ '^1-1[12][0-9]{2}$' and not "accounts"."is_header"));
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Hand-authored from here.
-- ---------------------------------------------------------------------------------------------

-- ---- accounts: the tree ------------------------------------------------------------------------
-- Plan §8.1: a parent is always a header (a postable account with lines that gets children would
-- be counted twice in roll-ups), a child has its parent's type, a header with sub-accounts stays a
-- header, and the parent chain has no cycle. Replaces 0049's accounts_parent_no_cycle, whose cycle
-- check could race: two concurrent parent changes could each pass and together form a cycle.
-- Every tree change (an insert under a parent, a parent change, a header switch) now takes one
-- transaction-level advisory lock first, so they run one at a time; at READ COMMITTED each query
-- below then reads with a fresh snapshot, after the previous change committed. At any other
-- isolation level the reads would use the transaction's older snapshot, so a tree change is
-- refused there (same reasoning as accounting_assert_period_open in 0049). A new account without
-- a parent has no children yet and changes no chain, so it needs no lock.
DROP TRIGGER IF EXISTS accounts_parent_no_cycle ON "accounts";--> statement-breakpoint
DROP FUNCTION IF EXISTS accounts_parent_no_cycle();--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounts_guard_tree()
RETURNS trigger AS $$
DECLARE
  parent accounts%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.parent_code IS NOT DISTINCT FROM OLD.parent_code AND NEW.is_header = OLD.is_header THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.parent_code IS NULL THEN
    RETURN NEW;
  END IF;
  -- An INSERT of a code that already exists is left to ON CONFLICT / the primary key (this BEFORE
  -- INSERT trigger fires before ON CONFLICT DO NOTHING is considered): re-seeding the Chart of
  -- Accounts after the accountant re-arranged headers must keep her tree, not validate the seed's
  -- original parent against it. Same reasoning as account_mappings_guard_target below.
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM accounts WHERE code = NEW.code) THEN
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'accounts: the account tree is changed only at READ COMMITTED isolation (this transaction is %)', current_setting('transaction_isolation')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'accounts_tree', TABLE = 'accounts';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ammari.accounts_tree'), 0);

  IF NEW.parent_code IS NOT NULL THEN
    SELECT * INTO parent FROM accounts WHERE code = NEW.parent_code;
    -- An unknown parent is left to the FK.
    IF FOUND AND NOT parent.is_header THEN
      RAISE EXCEPTION 'accounts %: parent % must be a header account', NEW.code, NEW.parent_code
        USING ERRCODE = 'check_violation', CONSTRAINT = 'accounts_tree', TABLE = 'accounts';
    END IF;
    IF FOUND AND parent.type <> NEW.type THEN
      RAISE EXCEPTION 'accounts %: a sub-account has its parent''s type (% is %)', NEW.code, NEW.parent_code, parent.type
        USING ERRCODE = 'check_violation', CONSTRAINT = 'accounts_tree', TABLE = 'accounts';
    END IF;
    IF EXISTS (
      WITH RECURSIVE ancestors(code) AS (
        SELECT NEW.parent_code
        UNION
        SELECT a.parent_code FROM accounts a JOIN ancestors ON a.code = ancestors.code WHERE a.parent_code IS NOT NULL
      )
      SELECT 1 FROM ancestors WHERE code = NEW.code
    ) THEN
      RAISE EXCEPTION 'accounts %: parent % would make a cycle', NEW.code, NEW.parent_code
        USING ERRCODE = 'check_violation', CONSTRAINT = 'accounts_tree', TABLE = 'accounts';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.is_header AND NOT NEW.is_header
     AND EXISTS (SELECT 1 FROM accounts WHERE parent_code = OLD.code) THEN
    RAISE EXCEPTION 'accounts %: a header with sub-accounts stays a header', OLD.code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'accounts_tree', TABLE = 'accounts';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER accounts_guard_tree BEFORE INSERT OR UPDATE OF "parent_code", "is_header" ON "accounts" FOR EACH ROW
  EXECUTE FUNCTION accounts_guard_tree();
--> statement-breakpoint

-- ---- accounts: identity, header, deactivation --------------------------------------------------
-- 0049's rules, plus: an account a mapping points at cannot become a header (the engine would then
-- post to a header and every journal of that mapping would fail). Same race reasoning as the
-- existing deactivation check: account_mappings_guard_target reads the account FOR SHARE, which
-- conflicts with this UPDATE's row lock, so one waits for the other and then sees its result.
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ---- account_mappings --------------------------------------------------------------------------
-- 0049's rule (an active, postable target, read FOR SHARE), plus the target's kind per key family,
-- mirrored by mappingTargetProblem in packages/accounting/src/mapping-rules.ts:
--   expense.category.* / expense.item.*  never an inventory account 1-15xx (D-14: raw materials
--                                        reach inventory only through goods receipts);
--   cash.method.* / cash.midtrans_payout a Kas & Bank account, 1-11xx or 1-12xx (D-17, D-18);
--   revenue.channel.*                    a revenue account;
--   supplier_payable.*                   a liability account.
-- And (plan §8.1) an INSERT of a key that already exists is left to ON CONFLICT / the primary key:
-- this BEFORE INSERT trigger fires before ON CONFLICT DO NOTHING is considered, so re-seeding a
-- database where the accountant re-mapped a default key and deactivated its original target used
-- to fail with "must be active". DO NOTHING now keeps the row, DO UPDATE re-checks the new target
-- through the UPDATE OF account_code trigger below, and a plain INSERT hits the primary key.
CREATE OR REPLACE FUNCTION account_mappings_guard_target()
RETURNS trigger AS $$
DECLARE
  target accounts%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM account_mappings WHERE mapping_key = NEW.mapping_key) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO target FROM accounts WHERE code = NEW.account_code FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF target.is_header OR NOT target.is_active THEN
    RAISE EXCEPTION 'account_mappings %: target account % must be active and not a header', NEW.mapping_key, NEW.account_code
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.mapping_key LIKE 'expense.category.%' OR NEW.mapping_key LIKE 'expense.item.%')
     AND target.code ~ '^1-15[0-9]{2}$' THEN
    RAISE EXCEPTION 'account_mappings %: an expense is never mapped to inventory account % (D-14)', NEW.mapping_key, NEW.account_code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_mappings_target_kind', TABLE = 'account_mappings';
  END IF;
  IF (NEW.mapping_key LIKE 'cash.method.%' OR NEW.mapping_key = 'cash.midtrans_payout')
     AND target.code !~ '^1-1[12][0-9]{2}$' THEN
    RAISE EXCEPTION 'account_mappings %: target % must be a cash or bank account (1-11xx, 1-12xx)', NEW.mapping_key, NEW.account_code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_mappings_target_kind', TABLE = 'account_mappings';
  END IF;
  IF NEW.mapping_key LIKE 'revenue.channel.%' AND target.type <> 'revenue' THEN
    RAISE EXCEPTION 'account_mappings %: target % must be a revenue account', NEW.mapping_key, NEW.account_code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_mappings_target_kind', TABLE = 'account_mappings';
  END IF;
  IF NEW.mapping_key LIKE 'supplier_payable.%' AND target.type <> 'liability' THEN
    RAISE EXCEPTION 'account_mappings %: target % must be a liability account', NEW.mapping_key, NEW.account_code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_mappings_target_kind', TABLE = 'account_mappings';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
