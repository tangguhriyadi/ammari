-- TikTok Shop T8, accounting reference data (docs/plans/tiktok-shop-integration.md §3.6, §5.4; Q8, Q17).
-- Data and one function body only, no table change: the previous release never reads the new key and
-- never writes a tiktok.adjustment.* mapping, so it keeps working against this schema (expand-only,
-- rollback-safe). Re-running is a no-op.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint

-- account_mappings_guard_target, 0051's body plus two key families (mirrored by mappingTargetProblem in
-- packages/accounting/src/mapping-rules.ts):
--   cash.tiktok_payout   a Kas & Bank account, 1-11xx or 1-12xx (M3: TikTok payouts go to Bank utama, Q17;
--                        the key lets the accountant point it at a sub-account);
--   tiktok.adjustment.*  never an inventory account 1-15xx and never Saldo Penjual TikTok itself (M5: the
--                        adjustment moves money in or out of 1-1303, so 1-1303 cannot be its other side).
-- Every other family is unchanged.
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
  IF (NEW.mapping_key LIKE 'expense.category.%' OR NEW.mapping_key LIKE 'expense.item.%' OR NEW.mapping_key LIKE 'tiktok.adjustment.%')
     AND target.code ~ '^1-15[0-9]{2}$' THEN
    RAISE EXCEPTION 'account_mappings %: an expense is never mapped to inventory account % (D-14)', NEW.mapping_key, NEW.account_code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_mappings_target_kind', TABLE = 'account_mappings';
  END IF;
  IF NEW.mapping_key LIKE 'tiktok.adjustment.%' AND target.system_key = 'seller_balance.tiktok' THEN
    RAISE EXCEPTION 'account_mappings %: a TikTok adjustment is never mapped to the seller balance % itself', NEW.mapping_key, NEW.account_code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_mappings_target_kind', TABLE = 'account_mappings';
  END IF;
  IF (NEW.mapping_key LIKE 'cash.method.%' OR NEW.mapping_key = 'cash.midtrans_payout' OR NEW.mapping_key = 'cash.tiktok_payout')
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
--> statement-breakpoint

-- M3's bank (Q17: Bank utama), only while 1-1201 still exists, is active and postable (the guard would
-- refuse it otherwise; an accountant who changed that maps the key herself, and M3 raises
-- unmapped_tiktok_payout until then). tiktok.adjustment.* keys get no row: the accountant maps every type
-- in Pemetaan Akun (Q8), an unmapped type is a posting issue.
INSERT INTO "account_mappings" ("mapping_key", "account_code")
SELECT 'cash.tiktok_payout', '1-1201'
WHERE EXISTS (SELECT 1 FROM "accounts" WHERE "code" = '1-1201' AND "is_active" AND NOT "is_header")
ON CONFLICT DO NOTHING;
